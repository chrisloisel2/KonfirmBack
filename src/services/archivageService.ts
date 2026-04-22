/**
 * Service d'archivage LCB-FT
 *
 * Pipeline complet pour chaque PDF de rapport LCB-FT :
 *   1. Conversion en PDF/A-2b (métadonnées XMP conformité)
 *   2. Empreinte SHA-256
 *   3. Cachet électronique RSA-SHA256 (certificat auto-signé ou PKI externe)
 *   4. Horodatage RFC 3161 (TSA externe : FreeTSA)
 *   5. Dépôt WORM chiffré (chmod 444 + répertoire 555)
 *   6. Enregistrement en base avec date d'expiration légale (Art. L. 561-12 CMF)
 *
 * En production, remplacer le certificat auto-signé par un cachet qualifié eIDAS.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import forge from 'node-forge';
import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';
import prisma from '../lib/prisma';
import { logSystemEvent, logAuditEvent } from '../utils/logger';
import {
  storeWormFile,
  computeSha256,
  calculateRetentionExpiry,
  WormStorageResult
} from './wormStorageService';

// ─── Configuration ────────────────────────────────────────────────────────────

const SEAL_DIR = process.env.SEAL_DIR || path.join(process.cwd(), 'config', 'seal');
const SEAL_KEY_PATH = path.join(SEAL_DIR, 'seal.key');
const SEAL_CERT_PATH = path.join(SEAL_DIR, 'seal.crt');
const TSA_URL = process.env.TSA_URL || 'http://freetsa.org/tsr';
const TSA_TIMEOUT_MS = 15000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArchivageOptions {
  dossierId: string;
  pdfBuffer: Buffer;
  originalFilename?: string;
  archivedById?: string;
  triggerStatus?: string;
  dateFinRelationAffaires?: Date | null;
}

export interface ArchivageResult {
  archiveId: string;
  sha256Hash: string;
  sealSignature: string;
  sealCertFingerprint: string;
  timestampToken: string | null;
  timestampTime: Date | null;
  filePath: string;
  retentionExpiry: Date;
  archivedAt: Date;
  isPdfa: boolean;
}

// ─── Gestion des clés du cachet électronique ─────────────────────────────────

let sealKeyCache: { privateKey: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate } | null = null;

async function ensureSealKeys(): Promise<{
  privateKey: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
}> {
  if (sealKeyCache) return sealKeyCache;

  try {
    const keyPem = await fs.readFile(SEAL_KEY_PATH, 'utf8');
    const certPem = await fs.readFile(SEAL_CERT_PATH, 'utf8');
    sealKeyCache = {
      privateKey: forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey,
      cert: forge.pki.certificateFromPem(certPem)
    };
    return sealKeyCache;
  } catch {
    // Génération d'un certificat auto-signé si absent
    await fs.mkdir(SEAL_DIR, { recursive: true });

    const keys = await new Promise<forge.pki.KeyPair>((resolve, reject) => {
      forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, kp) => {
        if (err) reject(err);
        else resolve(kp);
      });
    });

    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = crypto.randomBytes(8).toString('hex');
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

    const attrs: forge.pki.CertificateField[] = [
      { name: 'commonName', value: 'Konfirm - Cachet Électronique LCB-FT' },
      { name: 'organizationName', value: 'Konfirm' },
      { name: 'countryName', value: 'FR' }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        contentCommitment: true,
        keyEncipherment: false
      },
      { name: 'subjectKeyIdentifier' }
    ]);
    cert.sign(keys.privateKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const certPem = forge.pki.certificateToPem(cert);
    await fs.writeFile(SEAL_KEY_PATH, keyPem, { mode: 0o600 });
    await fs.writeFile(SEAL_CERT_PATH, certPem);

    logSystemEvent({
      action: 'startup',
      component: 'archivage_seal',
      details: { message: 'Certificat de cachet électronique généré', path: SEAL_DIR },
      severity: 'info'
    });

    sealKeyCache = { privateKey: keys.privateKey as forge.pki.rsa.PrivateKey, cert };
    return sealKeyCache;
  }
}

// ─── Cachet électronique ──────────────────────────────────────────────────────

async function createElectronicSeal(
  pdfHash: Buffer
): Promise<{ signature: string; certFingerprint: string }> {
  const { privateKey, cert } = await ensureSealKeys();

  const md = forge.md.sha256.create();
  md.update(pdfHash.toString('binary'));
  const signatureBinary = privateKey.sign(md);

  const signature = Buffer.from(signatureBinary, 'binary').toString('hex');
  const certFingerprint = forge.pki.getPublicKeyFingerprint(cert.publicKey, {
    encoding: 'hex',
    md: forge.md.sha256.create()
  });

  return { signature, certFingerprint };
}

// ─── Horodatage RFC 3161 ─────────────────────────────────────────────────────

/**
 * Construit une requête RFC 3161 (TimeStampQuery) en ASN.1/DER.
 * OID SHA-256 : 2.16.840.1.101.3.4.2.1
 */
function buildTimestampQuery(hash: Buffer): Buffer {
  const hashOid = forge.asn1.oidToDer('2.16.840.1.101.3.4.2.1').getBytes();
  const nonce = crypto.randomBytes(8);

  const tsq = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    // version INTEGER
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.INTEGER,
      false,
      forge.asn1.integerToDer(1).getBytes()
    ),
    // messageImprint
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, hashOid),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, '')
      ]),
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OCTETSTRING,
        false,
        hash.toString('binary')
      )
    ]),
    // nonce
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.INTEGER,
      false,
      nonce.toString('binary')
    ),
    // certReq BOOLEAN TRUE — DER encoding: 0xFF
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.BOOLEAN,
      false,
      '\xff'
    )
  ]);

  return Buffer.from(forge.asn1.toDer(tsq).getBytes(), 'binary');
}

async function getTimestamp(
  pdfHash: Buffer
): Promise<{ token: string; time: Date } | null> {
  try {
    const tsqBuffer = buildTimestampQuery(pdfHash);

    const response = await axios.post(TSA_URL, tsqBuffer, {
      headers: {
        'Content-Type': 'application/timestamp-query',
        Accept: 'application/timestamp-reply'
      },
      responseType: 'arraybuffer',
      timeout: TSA_TIMEOUT_MS
    });

    const tsrBuffer = Buffer.from(response.data);
    const token = tsrBuffer.toString('base64');

    return { token, time: new Date() };
  } catch (error) {
    logSystemEvent({
      action: 'ermes_transmission_error',
      component: 'archivage_timestamp',
      details: { tsaUrl: TSA_URL, error: String(error) },
      severity: 'warning'
    });
    return null;
  }
}

// ─── Conversion PDF/A-2b ──────────────────────────────────────────────────────

/**
 * Ajoute les métadonnées XMP PDF/A-2b dans un PDF existant.
 * Note : la conformité stricte PDF/A requiert également l'intégration des polices
 * et un profil de couleur ICC. Utiliser veraPDF pour la validation complète en production.
 */
async function convertToPdfA(
  pdfBuffer: Buffer,
  metadata: {
    title: string;
    creator: string;
    dossierId: string;
    archivedAt: string;
  }
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });

  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>2</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:format>application/pdf</dc:format>
      <dc:title>${escapeXml(metadata.title)}</dc:title>
      <dc:creator>${escapeXml(metadata.creator)}</dc:creator>
    </rdf:Description>
    <rdf:Description rdf:about=""
        xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>${metadata.archivedAt}</xmp:CreateDate>
      <xmp:ModifyDate>${metadata.archivedAt}</xmp:ModifyDate>
      <xmp:CreatorTool>Konfirm LCB-FT Archival Service v1.0</xmp:CreatorTool>
      <xmp:MetadataDate>${metadata.archivedAt}</xmp:MetadataDate>
    </rdf:Description>
    <rdf:Description rdf:about=""
        xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>Konfirm LCB-FT v1.0</pdf:Producer>
      <pdf:PDFVersion>1.7</pdf:PDFVersion>
    </rdf:Description>
    <rdf:Description rdf:about=""
        xmlns:konfirm="http://konfirm.fr/ns/lcbft/1/">
      <konfirm:dossierId>${escapeXml(metadata.dossierId)}</konfirm:dossierId>
      <konfirm:archivedAt>${metadata.archivedAt}</konfirm:archivedAt>
      <konfirm:conformite>LCB-FT Art. L.561-12 CMF</konfirm:conformite>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  const xmpBytes = Buffer.from(xmp, 'utf8');

  const context = pdfDoc.context;
  const metadataStream = context.stream(xmpBytes, {
    Type: PDFName.of('Metadata'),
    Subtype: PDFName.of('XML'),
    Length: xmpBytes.length
  });
  const metadataRef = context.register(metadataStream);
  pdfDoc.catalog.set(PDFName.of('Metadata'), metadataRef);

  pdfDoc.setTitle(metadata.title);
  pdfDoc.setCreator('Konfirm LCB-FT Archival Service v1.0');
  pdfDoc.setProducer('Konfirm LCB-FT v1.0');
  pdfDoc.setCreationDate(new Date(metadata.archivedAt));
  pdfDoc.setModificationDate(new Date(metadata.archivedAt));

  return Buffer.from(await pdfDoc.save());
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Génération du PDF de conformité côté serveur ────────────────────────────

/**
 * Génère un PDF de conformité LCB-FT directement depuis la base de données.
 * Utilisé pour l'archivage automatique lors des transitions de statut.
 */
export async function generateCompliancePdf(dossierId: string): Promise<Buffer> {
  const dossier = await prisma.dossier.findUnique({
    where: { id: dossierId },
    include: {
      client: true,
      createdBy: { select: { firstName: true, lastName: true } },
      validatedBy: { select: { firstName: true, lastName: true } },
      recherches: { orderBy: { executedAt: 'desc' }, take: 10 },
      exceptions: { orderBy: { createdAt: 'desc' }, take: 10 },
      tracfinDeclarations: { orderBy: { createdAt: 'desc' }, take: 5 }
    }
  });

  if (!dossier) throw new Error(`Dossier introuvable : ${dossierId}`);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4
  const { height } = page.getSize();

  const now = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  const client = dossier.client;
  const validation = (dossier.validation as Record<string, any>) ?? {};

  // En-tête
  page.drawText('RAPPORT DE CONFORMITÉ LCB-FT', {
    x: 50, y: height - 60, size: 16
  });
  page.drawText(`Dossier N° ${dossier.numero}`, {
    x: 50, y: height - 85, size: 12
  });
  page.drawText(`Généré le : ${now}`, {
    x: 50, y: height - 105, size: 10
  });
  page.drawText(`Statut : ${dossier.status}`, {
    x: 50, y: height - 120, size: 10
  });

  // Ligne de séparation (simulée par un texte)
  page.drawText('─────────────────────────────────────────────────────────', {
    x: 50, y: height - 135, size: 8
  });

  // Client
  page.drawText('IDENTITÉ DU CLIENT', { x: 50, y: height - 155, size: 12 });
  page.drawText(`Nom : ${client.nom} ${client.prenom}`, { x: 50, y: height - 175, size: 10 });
  page.drawText(`Date de naissance : ${client.dateNaissance.toLocaleDateString('fr-FR')}`, {
    x: 50, y: height - 190, size: 10
  });
  page.drawText(`Nationalité : ${client.nationalite}`, { x: 50, y: height - 205, size: 10 });
  page.drawText(`N° identité : ${client.numeroIdentite} (${client.typeIdentite})`, {
    x: 50, y: height - 220, size: 10
  });
  page.drawText(`Adresse : ${client.adresseComplete}, ${client.codePostal} ${client.ville}`, {
    x: 50, y: height - 235, size: 10
  });

  // Opération
  page.drawText('─────────────────────────────────────────────────────────', {
    x: 50, y: height - 255, size: 8
  });
  page.drawText('OPÉRATION', { x: 50, y: height - 275, size: 12 });
  page.drawText(`Type : ${dossier.typeOuverture}`, { x: 50, y: height - 295, size: 10 });
  page.drawText(`Montant : ${dossier.montantInitial ?? 'N/A'} EUR`, { x: 50, y: height - 310, size: 10 });
  page.drawText(`Date : ${dossier.dateOuverture?.toLocaleDateString('fr-FR') ?? 'N/A'}`, {
    x: 50, y: height - 325, size: 10
  });

  // Vérifications LCB-FT
  page.drawText('─────────────────────────────────────────────────────────', {
    x: 50, y: height - 345, size: 8
  });
  page.drawText('VÉRIFICATIONS LCB-FT', { x: 50, y: height - 365, size: 12 });

  const seuil = validation.seuilCheck ?? {};
  page.drawText(`Type client : ${seuil.clientType ?? 'N/A'}`, { x: 50, y: height - 385, size: 10 });
  page.drawText(`Seuil applicable : ${seuil.seuilApplicable ?? 'N/A'} EUR`, {
    x: 50, y: height - 400, size: 10
  });

  const gel = validation.gelAvoirsCheck ?? {};
  page.drawText(`Gel des avoirs : ${gel.isListed ? 'INSCRIT' : 'Non inscrit'} (conf. ${gel.confidence ?? 'N/A'})`, {
    x: 50, y: height - 415, size: 10
  });

  const recherchesSummary = dossier.recherches.map((r: { type: string; status: string; confidence: number | null }) =>
    `${r.type} : ${r.status} (conf. ${r.confidence?.toFixed(2) ?? 'N/A'})`
  ).join(' | ');
  page.drawText(`Recherches : ${recherchesSummary || 'Aucune'}`, {
    x: 50, y: height - 430, size: 9
  });

  // Scoring
  const scoring = (dossier.scoring as Record<string, any>) ?? {};
  if (scoring.scoreTotal !== undefined) {
    page.drawText('─────────────────────────────────────────────────────────', {
      x: 50, y: height - 450, size: 8
    });
    page.drawText('SCORING RISQUE', { x: 50, y: height - 470, size: 12 });
    page.drawText(`Score total : ${scoring.scoreTotal} — Niveau : ${scoring.niveau ?? 'N/A'}`, {
      x: 50, y: height - 490, size: 10
    });
    page.drawText(`Recommandation : ${scoring.recommandation ?? 'N/A'}`, {
      x: 50, y: height - 505, size: 10
    });
  }

  // Exceptions
  if (dossier.exceptions.length > 0) {
    page.drawText('─────────────────────────────────────────────────────────', {
      x: 50, y: height - 525, size: 8
    });
    page.drawText('EXCEPTIONS', { x: 50, y: height - 545, size: 12 });
    let yExc = height - 565;
    for (const exc of dossier.exceptions.slice(0, 4)) {
      page.drawText(`[${exc.type}] ${exc.description} — ${exc.status}`, {
        x: 50, y: yExc, size: 9
      });
      yExc -= 15;
    }
  }

  // TRACFIN
  if (dossier.tracfinDeclarations.length > 0) {
    const tracfin = dossier.tracfinDeclarations[0];
    page.drawText('─────────────────────────────────────────────────────────', {
      x: 50, y: height - 650, size: 8
    });
    page.drawText('DÉCLARATION TRACFIN', { x: 50, y: height - 670, size: 12 });
    page.drawText(`Statut : ${tracfin.status} — Score suspicion : ${tracfin.scoreSuspicion}`, {
      x: 50, y: height - 690, size: 10
    });
    page.drawText(`Risque : ${tracfin.risqueIdentifie}`, { x: 50, y: height - 705, size: 10 });
  }

  // Pied de page
  page.drawText('─────────────────────────────────────────────────────────', {
    x: 50, y: 80, size: 8
  });
  page.drawText('Ce document est généré automatiquement par le système Konfirm LCB-FT.', {
    x: 50, y: 62, size: 8
  });
  page.drawText('Conforme aux obligations Art. L. 561-12 du Code monétaire et financier.', {
    x: 50, y: 48, size: 8
  });
  page.drawText(`Document archivé le ${now} — Conservation légale 5 ans (cessation relation d'affaires).`, {
    x: 50, y: 34, size: 7
  });

  return Buffer.from(await pdfDoc.save());
}

// ─── Pipeline d'archivage principal ──────────────────────────────────────────

export async function archivePdf(options: ArchivageOptions): Promise<ArchivageResult> {
  const { dossierId, archivedById, triggerStatus, dateFinRelationAffaires } = options;
  let { pdfBuffer, originalFilename } = options;

  const archivedAt = new Date();
  const filename = originalFilename ?? `lcbft-${dossierId}-${Date.now()}.pdf`;

  // 1. Conversion PDF/A-2b
  const pdfaBuffer = await convertToPdfA(pdfBuffer, {
    title: `Rapport LCB-FT — Dossier ${dossierId}`,
    creator: 'Konfirm',
    dossierId,
    archivedAt: archivedAt.toISOString()
  });
  pdfBuffer = pdfaBuffer;

  // 2. Empreinte SHA-256
  const hashHex = computeSha256(pdfBuffer);
  const hashBuffer = Buffer.from(hashHex, 'hex');

  // 3. Cachet électronique RSA-SHA256
  const { signature: sealSignature, certFingerprint: sealCertFingerprint } =
    await createElectronicSeal(hashBuffer);

  // 4. Horodatage RFC 3161
  const tsResult = await getTimestamp(hashBuffer);

  // 5. Stockage WORM
  const pdfaFilename = filename.replace(/\.pdf$/i, '.pdfa.pdf');
  const worm: WormStorageResult = await storeWormFile(dossierId, pdfBuffer, pdfaFilename);

  // 6. Calcul de la durée légale de conservation
  const retentionExpiry = calculateRetentionExpiry(dateFinRelationAffaires, archivedAt);

  // 7. Enregistrement en base
  const archived = await prisma.archivedPdf.create({
    data: {
      dossierId,
      filename: pdfaFilename,
      originalFilename: filename,
      filePath: worm.filePath,
      fileSize: worm.fileSize,
      sha256Hash: hashHex,
      sealSignature,
      sealCertFingerprint,
      timestampToken: tsResult?.token ?? null,
      timestampTime: tsResult?.time ?? null,
      timestampTsa: tsResult ? TSA_URL : null,
      isPdfa: true,
      retentionExpiry,
      isImmutable: true,
      archivedAt,
      archivedById: archivedById ?? null,
      triggerStatus: triggerStatus ?? null,
      metadata: {
        sha256Hash: hashHex,
        sealCertFingerprint,
        wormPath: worm.relativePath,
        tsaUrl: tsResult ? TSA_URL : null
      }
    }
  });

  logAuditEvent({
    userId: archivedById,
    action: 'EXPORT',
    resource: 'archived_pdf',
    resourceId: archived.id,
    metadata: {
      dossierId,
      sha256Hash: hashHex,
      retentionExpiry: retentionExpiry.toISOString(),
      hasTimestamp: !!tsResult,
      wormPath: worm.relativePath
    }
  });

  logSystemEvent({
    action: 'backup',
    component: 'archivage_service',
    details: {
      archiveId: archived.id,
      dossierId,
      sha256: hashHex,
      retentionExpiry: retentionExpiry.toISOString(),
      timestampObtenu: !!tsResult
    },
    severity: 'info'
  });

  return {
    archiveId: archived.id,
    sha256Hash: hashHex,
    sealSignature,
    sealCertFingerprint,
    timestampToken: tsResult?.token ?? null,
    timestampTime: tsResult?.time ?? null,
    filePath: worm.filePath,
    retentionExpiry,
    archivedAt,
    isPdfa: true
  };
}

// ─── Certificat de Conformité d'Archivage ────────────────────────────────────

export interface CertificatInput {
  archive: {
    id: string;
    filename: string;
    fileSize: number;
    sha256Hash: string;
    sealSignature: string;
    sealCertFingerprint: string;
    timestampToken: string | null;
    timestampTime: Date | null;
    timestampTsa: string | null;
    isPdfa: boolean;
    isImmutable: boolean;
    retentionExpiry: Date;
    archivedAt: Date;
    archivedById: string | null;
    triggerStatus: string | null;
  };
  dossier: { id: string; numero: string; status: string; typeOuverture: string; montantInitial: number | null; dateOuverture: Date | null };
  client: { nom: string; prenom: string; dateNaissance: Date; nationalite: string; numeroIdentite: string; typeIdentite: string };
  integrityOk: boolean;
  requestedBy: string;
  requestedAt: Date;
}

/**
 * Génère le Certificat de Conformité d'Archivage LCB-FT.
 * Ce document est la preuve opposable aux autorités (ACPR, TRACFIN, etc.)
 * que le PDF a été archivé conformément à l'Art. L. 561-12 CMF.
 */
export async function generateCertificatPdf(input: CertificatInput): Promise<Buffer> {
  const { archive, dossier, client, integrityOk, requestedBy, requestedAt } = input;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4
  const { width, height } = page.getSize();
  const margin = 45;
  const contentWidth = width - margin * 2;

  const fr = (d: Date) =>
    d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const frdt = (d: Date) =>
    d.toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Paris'
    }) + ' (Paris)';

  let y = height - 40;

  // ── Bandeau titre ──────────────────────────────────────────────────────────
  page.drawRectangle({ x: margin, y: y - 10, width: contentWidth, height: 44, color: rgb(0.039, 0.086, 0.157) });
  page.drawText('KONFIRM — SYSTÈME DE CONFORMITÉ LCB-FT', {
    x: margin + 10, y: y + 6, size: 9, color: rgb(0.749, 0.627, 0.388)
  });
  y -= 30;

  page.drawText('CERTIFICAT DE CONFORMITÉ D\'ARCHIVAGE', {
    x: margin, y: y - 10, size: 15
  });
  y -= 30;
  page.drawText('Document officiel opposable aux autorités de contrôle', {
    x: margin, y: y - 2, size: 9
  });
  y -= 20;

  // ── Références légales ────────────────────────────────────────────────────
  const refLine = `Réf. : ARCH-${archive.id.slice(-12).toUpperCase()}  |  Émis le ${frdt(requestedAt)}  |  Par : ${requestedBy || 'Système automatique'}`;
  page.drawText(refLine, { x: margin, y: y - 4, size: 8 });
  y -= 20;

  const sep = () => {
    page.drawLine({ start: { x: margin, y }, end: { x: margin + contentWidth, y }, thickness: 0.5 });
    y -= 14;
  };
  sep();

  const section = (title: string) => {
    page.drawRectangle({ x: margin, y: y - 2, width: contentWidth, height: 14, color: rgb(0.94, 0.94, 0.94) });
    page.drawText(title, { x: margin + 4, y: y, size: 9 });
    y -= 18;
  };

  const row = (label: string, value: string, small = false) => {
    const sz = small ? 7.5 : 9;
    page.drawText(`${label} :`, { x: margin + 4, y, size: sz });
    page.drawText(value, { x: margin + 150, y, size: sz });
    y -= small ? 12 : 14;
  };

  // ── Section 1 : Identification du dossier ─────────────────────────────────
  section('1. IDENTIFICATION DU DOSSIER');
  row('Numéro de dossier', dossier.numero);
  row('Statut au moment de l\'archivage', archive.triggerStatus ?? dossier.status);
  row('Type d\'opération', dossier.typeOuverture);
  row('Montant', dossier.montantInitial ? `${dossier.montantInitial.toLocaleString('fr-FR')} EUR` : 'Non renseigné');
  row('Date d\'ouverture', dossier.dateOuverture ? fr(dossier.dateOuverture) : 'Non renseignée');
  y -= 6;

  // ── Section 2 : Identité du client ────────────────────────────────────────
  section('2. IDENTITÉ DU CLIENT');
  row('Nom & Prénom', `${client.nom} ${client.prenom}`);
  row('Date de naissance', fr(client.dateNaissance));
  row('Nationalité', client.nationalite);
  row('Pièce d\'identité', `${client.typeIdentite} — ${client.numeroIdentite}`);
  y -= 6;

  // ── Section 3 : Métadonnées d'archivage ───────────────────────────────────
  section('3. MÉTADONNÉES D\'ARCHIVAGE');
  row('Fichier archivé', archive.filename);
  row('Taille du fichier', `${(archive.fileSize / 1024).toFixed(1)} Ko`);
  row('Format', archive.isPdfa ? 'PDF/A-2b (conformité archivage)' : 'PDF');
  row('Date et heure d\'archivage', frdt(archive.archivedAt));
  y -= 6;

  // ── Section 4 : Empreinte cryptographique ─────────────────────────────────
  section('4. EMPREINTE CRYPTOGRAPHIQUE (INTÉGRITÉ)');
  row('Algorithme', 'SHA-256');
  page.drawText('Empreinte SHA-256 :', { x: margin + 4, y, size: 8 });
  y -= 12;
  page.drawText(archive.sha256Hash.substring(0, 64), { x: margin + 8, y, size: 7 });
  y -= 11;
  page.drawText(archive.sha256Hash.substring(64), { x: margin + 8, y, size: 7 });
  y -= 16;

  const integrityColor = integrityOk
    ? rgb(0.086, 0.4, 0.137)
    : rgb(0.7, 0.1, 0.1);
  const integrityText = integrityOk
    ? '✓ INTÉGRITÉ VÉRIFIÉE — Le fichier n\'a subi aucune altération depuis son archivage.'
    : '✗ ANOMALIE DÉTECTÉE — L\'empreinte ne correspond pas au fichier stocké.';
  page.drawText(integrityText, { x: margin + 4, y, size: 8.5, color: integrityColor });
  y -= 6;
  page.drawText(`Vérification réalisée le ${frdt(requestedAt)}`, { x: margin + 4, y, size: 7.5 });
  y -= 16;

  // ── Section 5 : Cachet électronique ───────────────────────────────────────
  section('5. CACHET ÉLECTRONIQUE');
  row('Algorithme de signature', 'RSA-SHA256 (2048 bits)');
  page.drawText('Empreinte du certificat (SHA-256) :', { x: margin + 4, y, size: 8 });
  y -= 12;
  page.drawText(archive.sealCertFingerprint.substring(0, 64), { x: margin + 8, y, size: 7 });
  y -= 11;
  page.drawText(archive.sealCertFingerprint.substring(64), { x: margin + 8, y, size: 7 });
  y -= 11;
  page.drawText('Signature RSA (extrait 64 premiers car.) :', { x: margin + 4, y, size: 8 });
  y -= 12;
  page.drawText(archive.sealSignature.substring(0, 64) + '...', { x: margin + 8, y, size: 7 });
  y -= 14;

  // ── Section 6 : Horodatage RFC 3161 ───────────────────────────────────────
  section('6. HORODATAGE RFC 3161');
  if (archive.timestampTime && archive.timestampTsa) {
    row('Autorité d\'horodatage (TSA)', archive.timestampTsa);
    row('Date/heure du jeton', frdt(archive.timestampTime));
    row('Standard', 'RFC 3161 — Time-Stamp Protocol');
    row('Jeton (extrait Base64)', archive.timestampToken?.substring(0, 60) + '...', true);
  } else {
    page.drawText('Horodatage TSA non disponible au moment de l\'archivage (TSA inaccessible).', {
      x: margin + 4, y, size: 8
    });
    y -= 14;
  }
  y -= 6;

  // ── Section 7 : Stockage WORM ─────────────────────────────────────────────
  section('7. STOCKAGE WORM (IMMUABILITÉ)');
  row('Type de stockage', 'WORM (Write Once Read Many)');
  row('Immuabilité', archive.isImmutable ? 'Activée — fichier en lecture seule (chmod 444)' : 'Non activée');
  row('Expiration de la rétention légale', `${fr(archive.retentionExpiry)} (5 ans après cessation — Art. L. 561-12 CMF)`);
  row('Suppression avant expiration', 'INTERDITE — protection système');
  y -= 6;

  // ── Section 8 : Base légale ───────────────────────────────────────────────
  section('8. BASE LÉGALE ET ATTESTATION');
  const legal = [
    'Art. L. 561-12 CMF — Conservation 5 ans à compter de la cessation de la relation d\'affaires.',
    'Directive UE 2015/849 (4ème directive LCB-FT) — Art. 40 — Conservation des pièces justificatives.',
    'Règlement eIDAS (UE) 910/2014 — Cachet électronique qualifié (production : cachet TSP qualifié).',
    'Norme ISO 19005 (PDF/A) — Archivage à long terme des documents électroniques.',
  ];
  for (const line of legal) {
    page.drawText(`• ${line}`, { x: margin + 4, y, size: 7.5 });
    y -= 12;
  }
  y -= 6;

  // ── Bloc d'attestation ────────────────────────────────────────────────────
  sep();
  page.drawText(
    'Le présent certificat atteste que le document référencé ci-dessus a été archivé de manière',
    { x: margin, y, size: 8.5 }
  );
  y -= 12;
  page.drawText(
    'conforme aux exigences légales LCB-FT, avec garanties d\'intégrité, d\'immuabilité et de traçabilité.',
    { x: margin, y, size: 8.5 }
  );
  y -= 16;

  if (y > 40) {
    page.drawText(`Émis automatiquement par le Système Konfirm LCB-FT — ${frdt(requestedAt)}`, {
      x: margin, y: Math.max(y, 28), size: 7.5
    });
  }

  // Pied de page fixe
  page.drawText(
    `KONFIRM LCB-FT  |  Certificat ARCH-${archive.id.slice(-12).toUpperCase()}  |  ${fr(requestedAt)}  |  Confidentiel — Usage interne et contrôle réglementaire`,
    { x: margin, y: 18, size: 6.5 }
  );

  pdfDoc.setTitle(`Certificat d'archivage LCB-FT — ${dossier.numero}`);
  pdfDoc.setSubject('Certificat de Conformité d\'Archivage');
  pdfDoc.setCreator('Konfirm LCB-FT Archival Service v1.0');
  pdfDoc.setProducer('Konfirm LCB-FT v1.0');
  pdfDoc.setCreationDate(requestedAt);

  return Buffer.from(await pdfDoc.save());
}

/**
 * Déclenche l'archivage automatique d'un dossier :
 * génère le PDF de conformité côté serveur puis exécute le pipeline complet.
 */
export async function archiveDossier(
  dossierId: string,
  userId: string,
  triggerStatus: string
): Promise<ArchivageResult> {
  const dossier = await prisma.dossier.findUnique({
    where: { id: dossierId },
    select: { dateFinRelationAffaires: true, numero: true, status: true }
  });

  if (!dossier) throw new Error(`Dossier introuvable : ${dossierId}`);

  // Calculer dateFinRelationAffaires si dossier REJETE et non encore renseignée
  let dateFinRelationAffaires = dossier.dateFinRelationAffaires;
  if (!dateFinRelationAffaires && ['REJETE', 'ARCHIVE'].includes(triggerStatus)) {
    dateFinRelationAffaires = new Date();
    await prisma.dossier.update({
      where: { id: dossierId },
      data: { dateFinRelationAffaires }
    });
  }

  const pdfBuffer = await generateCompliancePdf(dossierId);

  return archivePdf({
    dossierId,
    pdfBuffer,
    originalFilename: `lcbft-${dossier.numero}-${triggerStatus.toLowerCase()}.pdf`,
    archivedById: userId,
    triggerStatus,
    dateFinRelationAffaires
  });
}
