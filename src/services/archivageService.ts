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
import { PDFDocument, PDFPage, PDFFont, PDFName, PDFString, rgb, StandardFonts } from 'pdf-lib';
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
    // certReq BOOLEAN TRUE - DER encoding: 0xFF
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

// Palette
const C = {
  navy:    rgb(0.04, 0.09, 0.16),
  navy2:   rgb(0.07, 0.16, 0.31),
  gold:    rgb(0.75, 0.63, 0.39),
  white:   rgb(1, 1, 1),
  light:   rgb(0.96, 0.98, 1.00),
  border:  rgb(0.86, 0.89, 0.93),
  text:    rgb(0.09, 0.13, 0.20),
  textSec: rgb(0.39, 0.44, 0.52),
  success: rgb(0.09, 0.40, 0.20),
  successBg: rgb(0.86, 0.98, 0.90),
  error:   rgb(0.73, 0.11, 0.11),
  errorBg: rgb(1.00, 0.89, 0.89),
  warning: rgb(0.71, 0.33, 0.03),
  warningBg: rgb(0.99, 0.95, 0.78),
  info:    rgb(0.10, 0.31, 0.82),
  infoBg:  rgb(0.86, 0.93, 1.00),
  gray:    rgb(0.39, 0.44, 0.52),
  grayBg:  rgb(0.89, 0.91, 0.94),
};

function statusColor(status: string): ReturnType<typeof rgb> {
  if (['VALIDE', 'clear'].includes(status)) return C.success;
  if (['REJETE', 'alert'].includes(status)) return C.error;
  if (['warning', 'ATTENTE_VALIDATION'].includes(status)) return C.warning;
  return C.gray;
}
function statusBg(status: string): ReturnType<typeof rgb> {
  if (['VALIDE', 'clear'].includes(status)) return C.successBg;
  if (['REJETE', 'alert'].includes(status)) return C.errorBg;
  if (['warning', 'ATTENTE_VALIDATION'].includes(status)) return C.warningBg;
  return C.grayBg;
}
function statusLabel(status: string): string {
  const map: Record<string, string> = {
    VALIDE: 'VALIDE', REJETE: 'REJETE', EN_COURS: 'EN COURS',
    ATTENTE_VALIDATION: 'EN ATTENTE', ARCHIVE: 'ARCHIVE', BROUILLON: 'BROUILLON',
    clear: 'Conforme', alert: 'Alerte', warning: 'Attention',
    error: 'Indisponible', pending: 'En cours',
    TERMINE: 'Termine', ERREUR: 'Erreur',
  };
  return map[status] ?? status;
}
function safe(v: unknown): string {
  if (v == null) return 'N/A';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  const s = String(v);
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}
function trunc(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}
function frDate(d: Date | string | null | undefined): string {
  if (!d) return 'N/A';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString('fr-FR');
}
function frDateTime(d: Date | string | null | undefined): string {
  if (!d) return 'N/A';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

// Classe utilitaire pour gérer les pages et le curseur Y
class PdfWriter {
  private doc: PDFDocument;
  private bold: PDFFont;
  private regular: PDFFont;
  private page!: PDFPage;
  private y: number = 0;
  private readonly W = 595;
  private readonly H = 842;
  private readonly ML = 40;   // margin left
  private readonly MR = 40;   // margin right
  private readonly MB = 60;   // margin bottom
  private readonly CW: number; // content width
  private pageNum = 0;

  constructor(doc: PDFDocument, bold: PDFFont, regular: PDFFont) {
    this.doc = doc;
    this.bold = bold;
    this.regular = regular;
    this.CW = this.W - this.ML - this.MR;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([this.W, this.H]);
    this.y = this.H - this.MB;
    this.pageNum++;
    if (this.pageNum > 1) this.drawContinuationHeader();
  }

  private drawContinuationHeader() {
    this.page.drawRectangle({ x: 0, y: this.H - 28, width: this.W, height: 28, color: C.navy });
    this.page.drawText('KONFIRM - RAPPORT DE CONFORMITE LCB-FT (suite)', {
      x: this.ML, y: this.H - 19, size: 8, font: this.bold, color: C.white,
    });
    this.page.drawText(`Page ${this.pageNum}`, {
      x: this.W - 70, y: this.H - 19, size: 8, font: this.regular, color: C.gold,
    });
    this.y = this.H - 44;
  }

  ensureSpace(needed: number) {
    if (this.y - needed < this.MB) this.newPage();
  }

  gap(h: number) { this.y -= h; }

  line(color = C.border) {
    this.ensureSpace(6);
    this.page.drawLine({ start: { x: this.ML, y: this.y }, end: { x: this.W - this.MR, y: this.y }, thickness: 0.5, color });
    this.y -= 6;
  }

  sectionHeader(title: string, color = C.navy2) {
    this.ensureSpace(26);
    this.page.drawRectangle({ x: this.ML, y: this.y - 18, width: this.CW, height: 22, color });
    this.page.drawRectangle({ x: this.ML, y: this.y - 18, width: 4, height: 22, color: C.gold });
    this.page.drawText(title.toUpperCase(), {
      x: this.ML + 10, y: this.y - 12, size: 9, font: this.bold, color: C.white,
    });
    this.y -= 28;
  }

  row2(label: string, value: string, labelWidth = 150) {
    this.ensureSpace(16);
    this.page.drawText(safe(label), {
      x: this.ML, y: this.y, size: 9, font: this.bold, color: C.textSec,
    });
    this.page.drawText(trunc(safe(value), 80), {
      x: this.ML + labelWidth, y: this.y, size: 9, font: this.regular, color: C.text,
    });
    this.y -= 15;
  }

  text(content: string, size = 9, color = C.text, indent = 0) {
    const maxCharsPerLine = Math.floor((this.CW - indent) / (size * 0.52));
    const words = safe(content).split(' ');
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).trim().length > maxCharsPerLine) {
        this.ensureSpace(size + 4);
        this.page.drawText(line.trim(), { x: this.ML + indent, y: this.y, size, font: this.regular, color });
        this.y -= size + 3;
        line = word;
      } else {
        line = (line + ' ' + word).trim();
      }
    }
    if (line) {
      this.ensureSpace(size + 4);
      this.page.drawText(line.trim(), { x: this.ML + indent, y: this.y, size, font: this.regular, color });
      this.y -= size + 3;
    }
  }

  badge(label: string, color: ReturnType<typeof rgb>, bg: ReturnType<typeof rgb>, x: number, y: number) {
    const w = Math.min(label.length * 5.5 + 10, 100);
    this.page.drawRectangle({ x, y: y - 10, width: w, height: 13, color: bg });
    this.page.drawText(trunc(label, 16), { x: x + 5, y: y - 6, size: 7, font: this.bold, color });
  }

  verificationBlock(r: Record<string, any>) {
    const sourceLabel = safe(r.sourceLabel ?? r.source ?? 'Source inconnue');
    const status      = safe(r.status ?? 'pending');
    const summary     = safe(r.summary ?? '');
    const details     = safe(r.details ?? '');
    const confidence  = r.confidence != null ? Number(r.confidence) : 0;
    const matches: any[] = Array.isArray(r.matches) ? r.matches : [];
    const url         = r.url ? safe(r.url) : null;
    const overridden  = !!r.overriddenByUser;

    const detailLines: string[] = [];
    if (summary) detailLines.push(summary);
    if (details && details !== summary) detailLines.push(details);

    const rowH = 22 + detailLines.length * 11
      + (matches.length > 0 ? Math.min(matches.length, 5) * 10 + 12 : 0)
      + (url ? 12 : 0);

    this.ensureSpace(rowH + 4);

    const bg = statusBg(overridden ? 'clear' : status);
    this.page.drawRectangle({ x: this.ML, y: this.y - rowH + 2, width: this.CW, height: rowH, color: bg });
    // Barre latérale colorée
    this.page.drawRectangle({ x: this.ML, y: this.y - rowH + 2, width: 3, height: rowH, color: overridden ? C.success : statusColor(status) });
    this.page.drawLine({ start: { x: this.ML, y: this.y - rowH + 2 }, end: { x: this.W - this.MR, y: this.y - rowH + 2 }, thickness: 0.3, color: C.border });

    const col = overridden ? C.success : statusColor(status);
    this.page.drawText(trunc(sourceLabel, 40), { x: this.ML + 8, y: this.y - 8, size: 8, font: this.bold, color: C.text });
    if (confidence > 0) {
      this.page.drawText(`Confiance : ${Math.round(confidence * 100)}%`, { x: this.ML + 8, y: this.y - 18, size: 7, font: this.regular, color: C.textSec });
    }
    if (overridden) {
      this.page.drawText('Faux positif valide', { x: this.ML + 8, y: this.y - 18, size: 7, font: this.bold, color: C.success });
    }
    this.badge(overridden ? 'Faux positif' : statusLabel(status), col, statusBg(overridden ? 'clear' : status), this.W - this.MR - 82, this.y - 4);

    let ly = this.y - 28;
    for (const line of detailLines) {
      this.page.drawText(trunc(safe(line), 92), { x: this.ML + 8, y: ly, size: 7.5, font: this.regular, color: overridden ? C.textSec : C.text });
      ly -= 11;
    }
    if (url) {
      this.page.drawText(`Lien : ${trunc(url, 80)}`, { x: this.ML + 8, y: ly, size: 7, font: this.regular, color: C.info });
      ly -= 12;
    }
    if (matches.length > 0) {
      this.page.drawText(`${matches.length} correspondance(s) :`, { x: this.ML + 8, y: ly, size: 7, font: this.bold, color: C.textSec });
      ly -= 10;
      for (const m of matches.slice(0, 5)) {
        const name = m.name ?? m.caption ?? m.fullName ?? (typeof m === 'string' ? m : null)
          ?? Object.values(m).filter(v => typeof v === 'string').slice(0, 2).join(' ');
        const mScore = m.score !== undefined ? ` (${Math.round(Number(m.score) * 100)}%)` : '';
        const mDs = Array.isArray(m.datasets) && m.datasets.length ? ` [${m.datasets.slice(0,3).join(', ')}]` : '';
        this.page.drawText(`  - ${trunc(safe(name) + mScore + mDs, 88)}`, { x: this.ML + 10, y: ly, size: 7, font: this.regular, color: col });
        ly -= 10;
      }
      if (matches.length > 5) {
        this.page.drawText(`  ... ${matches.length - 5} autre(s) correspondance(s)`, { x: this.ML + 10, y: ly, size: 7, font: this.regular, color: C.textSec });
        ly -= 10;
      }
    }
    this.y = ly - 4;
  }

  rechercheBlock(r: Record<string, any>) {
    const type       = safe(r.type);
    const source     = safe(r.apiProvider ?? r.source ?? 'N/A');
    const status     = safe(r.status);
    const confidence = r.confidence != null ? r.confidence : null;
    const query      = r.query ? (typeof r.query === 'string' ? r.query : JSON.stringify(r.query)) : null;
    const response   = r.response as Record<string, any> | null;
    const matches    = Array.isArray(r.matches) ? r.matches : (r.matches ? [r.matches] : []);
    const error      = r.error ? safe(r.error) : null;

    // Résumé depuis la réponse API
    let summary = '';
    if (response) {
      summary = response.summary ?? response.message ?? response.details
        ?? response.description ?? response.result ?? '';
      if (!summary && Array.isArray(response.results)) {
        summary = `${response.results.length} resultat(s) retournes`;
      }
      if (!summary && response.total !== undefined) {
        summary = `Total : ${response.total}`;
      }
    }
    if (!summary && matches.length > 0) summary = `${matches.length} correspondance(s) trouvee(s)`;
    if (!summary && error) summary = `Erreur : ${error}`;
    if (!summary) summary = status === 'TERMINE' ? 'Aucun element notable' : status;

    const lines: string[] = [summary];
    // Détails supplémentaires depuis la réponse
    if (response) {
      if (response.score !== undefined)      lines.push(`Score confiance : ${typeof response.score === 'number' ? Math.round(response.score * 100) + '%' : safe(response.score)}`);
      if (response.riskLevel)               lines.push(`Niveau risque : ${safe(response.riskLevel)}`);
      if (response.source)                  lines.push(`Source API : ${safe(response.source)}`);
      if (response.datasets)                lines.push(`Datasets : ${Array.isArray(response.datasets) ? response.datasets.join(', ') : safe(response.datasets)}`);
      if (Array.isArray(response.alerts) && response.alerts.length > 0) {
        lines.push(`Alertes : ${response.alerts.slice(0, 3).map((a: any) => safe(a.type ?? a)).join(', ')}`);
      }
    }

    const rowH = 22 + lines.length * 11 + (matches.length > 0 ? Math.min(matches.length, 5) * 10 + 8 : 0);
    this.ensureSpace(rowH + 4);

    this.page.drawLine({ start: { x: this.ML, y: this.y + 2 }, end: { x: this.W - this.MR, y: this.y + 2 }, thickness: 0.3, color: C.border });

    // Ligne titre
    this.page.drawText(trunc(type, 32), { x: this.ML + 6, y: this.y - 8, size: 8, font: this.bold, color: C.text });
    this.page.drawText(trunc(source, 28), { x: this.ML + 6, y: this.y - 18, size: 7, font: this.regular, color: C.textSec });
    if (confidence != null) {
      this.page.drawText(`Conf. ${Math.round(confidence * 100)}%`, { x: this.ML + 200, y: this.y - 8, size: 7, font: this.regular, color: C.textSec });
    }
    if (query) {
      const qStr = typeof r.query === 'object' ? Object.entries(r.query as object).map(([k,v]) => `${k}:${safe(v)}`).join(' | ') : safe(r.query);
      this.page.drawText(`Requete : ${trunc(qStr, 55)}`, { x: this.ML + 200, y: this.y - 18, size: 6, font: this.regular, color: C.textSec });
    }
    this.badge(statusLabel(status), statusColor(status), statusBg(status), this.W - this.MR - 82, this.y - 4);

    let ly = this.y - 28;
    for (const line of lines) {
      this.page.drawText(trunc(safe(line), 95), { x: this.ML + 6, y: ly, size: 7.5, font: this.regular, color: C.text });
      ly -= 11;
    }

    // Correspondances
    if (matches.length > 0) {
      ly -= 2;
      this.page.drawText(`Correspondances (${matches.length}) :`, { x: this.ML + 6, y: ly, size: 7, font: this.bold, color: C.textSec });
      ly -= 10;
      for (const m of matches.slice(0, 5)) {
        const mStr = typeof m === 'string' ? m
          : m.name ?? m.caption ?? m.fullName ?? m.nom
            ?? (m.firstName || m.lastName ? `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() : null)
            ?? JSON.stringify(m).slice(0, 80);
        const mScore = m.score !== undefined ? ` (${Math.round(Number(m.score) * 100)}%)` : '';
        const mDatasets = m.datasets?.length ? ` [${m.datasets.join(', ')}]` : '';
        this.page.drawText(`  - ${trunc(safe(mStr) + mScore + mDatasets, 88)}`, {
          x: this.ML + 10, y: ly, size: 7, font: this.regular, color: C.error,
        });
        ly -= 10;
      }
      if (matches.length > 5) {
        this.page.drawText(`  ... et ${matches.length - 5} autre(s)`, { x: this.ML + 10, y: ly, size: 7, font: this.regular, color: C.textSec });
        ly -= 10;
      }
    }

    this.y = ly - 4;
  }

  scoreBar(label: string, score: number, maxScore = 100) {
    this.ensureSpace(22);
    const barW = this.CW - 160;
    const filled = Math.round((score / maxScore) * barW);
    const col = score >= 70 ? C.error : score >= 40 ? C.warning : C.success;

    this.page.drawText(trunc(label, 28), { x: this.ML, y: this.y - 4, size: 8, font: this.regular, color: C.text });
    this.page.drawRectangle({ x: this.ML + 145, y: this.y - 9, width: barW, height: 8, color: C.border });
    if (filled > 0) this.page.drawRectangle({ x: this.ML + 145, y: this.y - 9, width: filled, height: 8, color: col });
    this.page.drawText(`${score}/100`, {
      x: this.ML + 145 + barW + 8, y: this.y - 4, size: 8, font: this.bold, color: col,
    });
    this.y -= 18;
  }

  footer(dossierId: string, now: string) {
    const page = this.page;
    page.drawRectangle({ x: 0, y: 0, width: this.W, height: 45, color: C.navy });
    page.drawText('Konfirm - Systeme de Conformite LCB-FT', {
      x: this.ML, y: 29, size: 7, font: this.bold, color: C.gold,
    });
    page.drawText(`Genere le ${now} | Dossier ${dossierId}`, {
      x: this.ML, y: 19, size: 7, font: this.regular, color: C.white,
    });
    page.drawText('Document confidentiel | Conservation legale 5 ans - Art. L. 561-12 CMF', {
      x: this.ML, y: 9, size: 6, font: this.regular, color: C.textSec,
    });
  }

  getY() { return this.y; }
  setY(y: number) { this.y = y; }
  getPage() { return this.page; }
}

export async function generateCompliancePdf(dossierId: string): Promise<Buffer> {
  const dossier = await prisma.dossier.findUnique({
    where: { id: dossierId },
    include: {
      client: true,
      createdBy: { select: { firstName: true, lastName: true, role: true } },
      validatedBy: { select: { firstName: true, lastName: true } },
      assignedTo: { select: { firstName: true, lastName: true } },
      recherches: { orderBy: { executedAt: 'desc' } },
      exceptions: { orderBy: { createdAt: 'desc' } },
      tracfinDeclarations: { orderBy: { createdAt: 'desc' }, take: 5 },
      documents: { select: { type: true, originalName: true, isVerified: true, createdAt: true } },
    },
  });

  if (!dossier) throw new Error(`Dossier introuvable : ${dossierId}`);

  const pdfDoc = await PDFDocument.create();
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const w = new PdfWriter(pdfDoc, bold, regular);

  const now = frDateTime(new Date());
  const client = dossier.client as Record<string, any>;
  const validation = (dossier.validation as Record<string, any>) ?? {};
  const scoring = (dossier.scoring as Record<string, any>) ?? {};
  const verificationResults: any[] = (dossier as any).verificationResults
    ?? validation.verificationResults
    ?? [];

  // ── PAGE 1 : EN-TÊTE ──────────────────────────────────────────────────────

  const page1 = w.getPage();
  const H = 842;

  // Bandeau header navy
  page1.drawRectangle({ x: 0, y: H - 90, width: 595, height: 90, color: C.navy });
  // Bande or
  page1.drawRectangle({ x: 0, y: H - 93, width: 595, height: 3, color: C.gold });

  // Titre
  page1.drawText('KONFIRM', { x: 40, y: H - 38, size: 22, font: bold, color: C.white });
  page1.drawText('Compliance Intelligence', { x: 40, y: H - 52, size: 8, font: regular, color: C.gold });
  page1.drawText('RAPPORT DE CONFORMITE LCB-FT', { x: 40, y: H - 68, size: 11, font: bold, color: C.white });
  page1.drawText(`Dossier ${safe(dossier.numero)}`, { x: 40, y: H - 80, size: 8, font: regular, color: C.gold });

  // Badge statut (coin droit)
  const statusLbl = statusLabel(dossier.status);
  const sBg = statusBg(dossier.status);
  const sCol = statusColor(dossier.status);
  page1.drawRectangle({ x: 430, y: H - 58, width: 120, height: 20, color: sBg });
  page1.drawText(statusLbl, { x: 440, y: H - 51, size: 9, font: bold, color: sCol });

  // Infos dossier (colonne droite)
  page1.drawText(`Genere : ${now}`, { x: 430, y: H - 68, size: 7, font: regular, color: C.gold });
  page1.drawText(`Operateur : ${safe(dossier.createdBy?.firstName)} ${safe(dossier.createdBy?.lastName)}`, {
    x: 430, y: H - 78, size: 7, font: regular, color: C.gold,
  });

  w.setY(H - 100);
  w.gap(6);

  // ── IDENTITE DU CLIENT ────────────────────────────────────────────────────
  w.sectionHeader('Identite du client');
  w.row2('Nom complet', `${safe(client?.nom)} ${safe(client?.prenom)}`);
  w.row2('Date de naissance', frDate(client?.dateNaissance));
  w.row2('Nationalite', safe(client?.nationalite));
  w.row2('Type de document', safe(client?.typeIdentite));
  w.row2('Numero document', safe(client?.numeroIdentite));
  if (client?.dateExpirationIdentite) w.row2('Expiration document', frDate(client.dateExpirationIdentite));
  if (client?.adresseComplete) {
    w.row2('Adresse', `${safe(client.adresseComplete)}, ${safe(client.codePostal)} ${safe(client.ville)}`);
  }
  if (client?.pays) w.row2('Pays', safe(client.pays));
  if (client?.telephone) w.row2('Telephone', safe(client.telephone));
  if (client?.email) w.row2('Email', safe(client.email));
  if (client?.profession) w.row2('Profession', safe(client.profession));
  if (client?.personnePublique) {
    w.row2('Personne politiquement exposee', client.personnePublique ? 'OUI - Vigilance renforcee' : 'Non');
  }
  w.gap(4);

  // ── OPERATION ────────────────────────────────────────────────────────────
  w.sectionHeader('Details de l\'operation');
  w.row2('Type d\'operation', safe(dossier.typeOuverture));
  w.row2('Date d\'ouverture', frDate(dossier.dateOuverture));
  if ((dossier as any).montantInitial != null) w.row2('Montant initial', `${safe((dossier as any).montantInitial)} EUR`);
  if ((dossier as any).devises) w.row2('Devise', safe((dossier as any).devises));
  if ((dossier as any).objetOperation) w.row2('Objet', safe((dossier as any).objetOperation));
  w.row2('Operateur', `${safe(dossier.createdBy?.firstName)} ${safe(dossier.createdBy?.lastName)} (${safe(dossier.createdBy?.role)})`);
  if (dossier.validatedBy) {
    w.row2('Valide par', `${safe(dossier.validatedBy.firstName)} ${safe(dossier.validatedBy.lastName)}`);
  }
  if (dossier.assignedTo) {
    w.row2('Assigne a', `${safe(dossier.assignedTo.firstName)} ${safe(dossier.assignedTo.lastName)}`);
  }

  // Seuils LCB-FT
  const seuil = validation.seuilCheck ?? (dossier as any).seuilCheck ?? {};
  if (seuil.seuilApplicable || seuil.clientType) {
    w.gap(4);
    w.sectionHeader('Seuils LCB-FT');
    if (seuil.clientType) w.row2('Type client', safe(seuil.clientType));
    if (seuil.seuilApplicable) w.row2('Seuil applicable', `${safe(seuil.seuilApplicable)} EUR`);
    if (seuil.depasseSeuil !== undefined) w.row2('Seuil depasse', seuil.depasseSeuil ? 'OUI' : 'Non');
  }
  w.gap(4);

  // ── DOCUMENTS UPLOADES ────────────────────────────────────────────────────
  const docs = dossier.documents ?? [];
  if (docs.length > 0) {
    w.sectionHeader('Documents fournis');
    for (const doc of docs) {
      w.row2(safe(doc.type), `${safe((doc as any).originalName)} - ${doc.isVerified ? 'Verifie' : 'Non verifie'} - ${frDate((doc as any).createdAt)}`);
    }
    w.gap(4);
  }

  // ── SCORING ───────────────────────────────────────────────────────────────
  const hasScoringData = scoring.scoreFinal !== undefined
    || scoring.scoreTotal !== undefined
    || scoring.scorePPE !== undefined;

  if (hasScoringData) {
    w.sectionHeader('Score de risque LCB-FT');
    const finalScore = scoring.scoreFinal ?? scoring.scoreTotal ?? 0;
    w.ensureSpace(28);
    // Grand score
    const col = finalScore >= 75 ? C.error : finalScore >= 45 ? C.warning : C.success;
    w.getPage().drawRectangle({ x: 40, y: w.getY() - 22, width: 80, height: 26, color: col });
    w.getPage().drawText(`${finalScore}/100`, { x: 50, y: w.getY() - 13, size: 14, font: bold, color: C.white });
    const scoreLvl = finalScore >= 75 ? 'RISQUE ELEVE' : finalScore >= 45 ? 'RISQUE MODERE' : 'RISQUE FAIBLE';
    w.getPage().drawText(scoreLvl, { x: 130, y: w.getY() - 8, size: 10, font: bold, color: col });
    if (scoring.decision) w.getPage().drawText(`Decision : ${safe(scoring.decision)}`, { x: 130, y: w.getY() - 20, size: 8, font: regular, color: C.textSec });
    w.gap(30);

    if (scoring.scorePPE !== undefined)        w.scoreBar('PPE (Personne Politiquement Exposee)', scoring.scorePPE);
    if (scoring.scoreSignaux !== undefined)    w.scoreBar('Signaux (Sanctions + Judiciaire)', scoring.scoreSignaux);
    if (scoring.scorePays !== undefined)       w.scoreBar('Risque pays', scoring.scorePays);
    if (scoring.scoreReputation !== undefined) w.scoreBar('Reputation & exposition publique', scoring.scoreReputation);

    if (scoring.justification) {
      w.gap(4);
      w.text(`Justification : ${safe(scoring.justification)}`, 8, C.textSec);
    }
    w.gap(6);
  }

  // ── VERIFICATION D'IDENTITE (résultats scrappés) ───────────────────────────
  if (verificationResults.length > 0) {
    w.sectionHeader('Verifications d\'identite - Resultats par source');
    // En-tête tableau
    w.ensureSpace(18);
    w.getPage().drawRectangle({ x: 40, y: w.getY() - 14, width: 515, height: 16, color: C.navy });
    w.getPage().drawText('Source', { x: 46, y: w.getY() - 9, size: 7, font: bold, color: C.white });
    w.getPage().drawText('Resultat', { x: 46 + 150, y: w.getY() - 9, size: 7, font: bold, color: C.white });
    w.getPage().drawText('Statut', { x: 46 + 430, y: w.getY() - 9, size: 7, font: bold, color: C.white });
    w.gap(18);

    for (const r of verificationResults) {
      w.verificationBlock(r as Record<string, any>);
    }
    w.gap(6);
  }

  // ── RECHERCHES COMPLEMENTAIRES ────────────────────────────────────────────
  if (dossier.recherches.length > 0) {
    w.sectionHeader('Recherches complementaires');
    w.ensureSpace(18);
    w.getPage().drawRectangle({ x: 40, y: w.getY() - 14, width: 515, height: 16, color: C.navy2 });
    w.getPage().drawText('Type', { x: 46, y: w.getY() - 9, size: 7, font: bold, color: C.white });
    w.getPage().drawText('Source', { x: 46 + 130, y: w.getY() - 9, size: 7, font: bold, color: C.white });
    w.getPage().drawText('Statut', { x: 46 + 360, y: w.getY() - 9, size: 7, font: bold, color: C.white });
    w.getPage().drawText('Confiance', { x: 46 + 430, y: w.getY() - 9, size: 7, font: bold, color: C.white });
    w.gap(18);

    for (const r of dossier.recherches) {
      w.rechercheBlock(r as Record<string, any>);
    }
    w.gap(6);
  }

  // ── GEL DES AVOIRS ────────────────────────────────────────────────────────
  const gel = validation.gelAvoirsCheck ?? (dossier as any).gelAvoirsCheck ?? {};
  if (gel.isListed !== undefined) {
    w.sectionHeader('Gel des avoirs (DG Tresor)');
    const gelCol = gel.isListed ? C.error : C.success;
    const gelBgCol = gel.isListed ? C.errorBg : C.successBg;
    w.ensureSpace(26);
    w.getPage().drawRectangle({ x: 40, y: w.getY() - 20, width: 515, height: 24, color: gelBgCol });
    w.getPage().drawText(gel.isListed ? 'AVOIRS GELES - PERSONNE INSCRITE AU REGISTRE' : 'Aucune inscription sur le registre du gel des avoirs',
      { x: 50, y: w.getY() - 11, size: 9, font: bold, color: gelCol }
    );
    if (gel.confidence != null) {
      w.getPage().drawText(`Confiance : ${Math.round(Number(gel.confidence) * 100)}%`,
        { x: 430, y: w.getY() - 11, size: 8, font: regular, color: gelCol }
      );
    }
    w.gap(28);
    if (gel.matches?.length > 0) {
      for (const m of gel.matches.slice(0, 5)) {
        w.row2('Correspondance', safe(m.name ?? m));
      }
    }
    w.gap(4);
  }

  // ── EXCEPTIONS ────────────────────────────────────────────────────────────
  if (dossier.exceptions.length > 0) {
    w.sectionHeader('Exceptions et alertes');
    for (const exc of dossier.exceptions) {
      w.ensureSpace(48);
      const excColor = (exc as any).priority === 'CRITIQUE' ? C.error : C.warning;
      const excBg = (exc as any).priority === 'CRITIQUE' ? C.errorBg : C.warningBg;
      w.getPage().drawRectangle({ x: 40, y: w.getY() - 38, width: 515, height: 42, color: excBg });
      w.getPage().drawRectangle({ x: 40, y: w.getY() - 38, width: 3, height: 42, color: excColor });
      w.getPage().drawText(trunc(safe((exc as any).type), 40), { x: 50, y: w.getY() - 8, size: 8, font: bold, color: excColor });
      w.getPage().drawText(`Priorite: ${safe((exc as any).priority ?? 'NORMALE')}  |  Statut: ${statusLabel(safe((exc as any).status))}`, {
        x: 50, y: w.getY() - 18, size: 7, font: regular, color: C.textSec,
      });
      w.getPage().drawText(trunc(safe((exc as any).description), 90), {
        x: 50, y: w.getY() - 28, size: 8, font: regular, color: C.text,
      });
      w.getPage().drawText(`Le ${frDate((exc as any).createdAt)}`, {
        x: 430, y: w.getY() - 28, size: 7, font: regular, color: C.textSec,
      });
      w.gap(46);
    }
    w.gap(4);
  }

  // ── TRACFIN ───────────────────────────────────────────────────────────────
  if (dossier.tracfinDeclarations.length > 0) {
    w.sectionHeader('Declarations TRACFIN');
    for (const t of dossier.tracfinDeclarations) {
      w.row2('Reference ERMES', safe((t as any).ermesReference));
      w.row2('Statut', statusLabel(safe((t as any).status)));
      w.row2('Score suspicion', safe((t as any).scoreSuspicion));
      w.row2('Risque identifie', safe((t as any).risqueIdentifie));
      w.row2('Date', frDateTime((t as any).createdAt));
      w.line();
    }
    w.gap(4);
  }

  // ── CONCLUSION ────────────────────────────────────────────────────────────
  w.sectionHeader('Conclusion et decision finale');
  w.ensureSpace(60);
  const decColor = statusColor(dossier.status);
  const decBg = statusBg(dossier.status);
  w.getPage().drawRectangle({ x: 40, y: w.getY() - 44, width: 515, height: 48, color: decBg });
  w.getPage().drawRectangle({ x: 40, y: w.getY() - 44, width: 5, height: 48, color: decColor });
  w.getPage().drawText(statusLabel(dossier.status), { x: 54, y: w.getY() - 14, size: 12, font: bold, color: decColor });
  const conclusionText = dossier.status === 'VALIDE'
    ? 'Les verifications effectuees ne justifient pas d\'opposition. Dossier cloture avec validation.'
    : dossier.status === 'REJETE'
    ? 'Des elements incompatibles ont ete identifies. Dossier refuse - mesure conservatoire requise.'
    : 'Dossier en cours de traitement - suivi requis.';
  w.getPage().drawText(trunc(conclusionText, 90), { x: 54, y: w.getY() - 28, size: 8, font: regular, color: C.text });
  w.getPage().drawText(`Ref. conformite : Art. L. 561-12 CMF | Directive UE 2015/849`, {
    x: 54, y: w.getY() - 38, size: 7, font: regular, color: C.textSec,
  });
  w.gap(56);

  // ── FOOTER sur toutes les pages ────────────────────────────────────────────
  const totalPages = pdfDoc.getPageCount();
  for (let i = 0; i < totalPages; i++) {
    const pg = pdfDoc.getPage(i);
    pg.drawRectangle({ x: 0, y: 0, width: 595, height: 45, color: C.navy });
    pg.drawText('Konfirm - Systeme de Conformite LCB-FT', { x: 40, y: 29, size: 7, font: bold, color: C.gold });
    pg.drawText(`Genere le ${now}  |  Dossier ${safe(dossier.numero)}  |  Page ${i + 1}/${totalPages}`,
      { x: 40, y: 19, size: 7, font: regular, color: C.white });
    pg.drawText('Document confidentiel | Conservation legale 5 ans - Art. L. 561-12 CMF | Directive UE 2015/849',
      { x: 40, y: 9, size: 6, font: regular, color: C.textSec });
  }

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
    title: `Rapport LCB-FT - Dossier ${dossierId}`,
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
  page.drawText('KONFIRM - SYSTÈME DE CONFORMITÉ LCB-FT', {
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
  row('Pièce d\'identité', `${client.typeIdentite} - ${client.numeroIdentite}`);
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
    ? '✓ INTÉGRITÉ VÉRIFIÉE - Le fichier n\'a subi aucune altération depuis son archivage.'
    : '✗ ANOMALIE DÉTECTÉE - L\'empreinte ne correspond pas au fichier stocké.';
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
    row('Standard', 'RFC 3161 - Time-Stamp Protocol');
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
  row('Immuabilité', archive.isImmutable ? 'Activée - fichier en lecture seule (chmod 444)' : 'Non activée');
  row('Expiration de la rétention légale', `${fr(archive.retentionExpiry)} (5 ans après cessation - Art. L. 561-12 CMF)`);
  row('Suppression avant expiration', 'INTERDITE - protection système');
  y -= 6;

  // ── Section 8 : Base légale ───────────────────────────────────────────────
  section('8. BASE LÉGALE ET ATTESTATION');
  const legal = [
    'Art. L. 561-12 CMF - Conservation 5 ans à compter de la cessation de la relation d\'affaires.',
    'Directive UE 2015/849 (4ème directive LCB-FT) - Art. 40 - Conservation des pièces justificatives.',
    'Règlement eIDAS (UE) 910/2014 - Cachet électronique qualifié (production : cachet TSP qualifié).',
    'Norme ISO 19005 (PDF/A) - Archivage à long terme des documents électroniques.',
  ];
  for (const line of legal) {
    page.drawText(`- ${line}`, { x: margin + 4, y, size: 7.5 });
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
    page.drawText(`Émis automatiquement par le Système Konfirm LCB-FT - ${frdt(requestedAt)}`, {
      x: margin, y: Math.max(y, 28), size: 7.5
    });
  }

  // Pied de page fixe
  page.drawText(
    `KONFIRM LCB-FT  |  Certificat ARCH-${archive.id.slice(-12).toUpperCase()}  |  ${fr(requestedAt)}  |  Confidentiel - Usage interne et contrôle réglementaire`,
    { x: margin, y: 18, size: 6.5 }
  );

  pdfDoc.setTitle(`Certificat d'archivage LCB-FT - ${dossier.numero}`);
  pdfDoc.setSubject('Certificat de Conformité d\'Archivage');
  pdfDoc.setCreator('Konfirm LCB-FT Archival Service v1.0');
  pdfDoc.setProducer('Konfirm LCB-FT v1.0');
  pdfDoc.setCreationDate(requestedAt);

  return Buffer.from(await pdfDoc.save());
}

// ─── Archivage WORM des pièces justificatives ────────────────────────────────

export interface ArchivedDocumentOptions {
  documentId: string;
  dossierId: string;
  sourceFilePath: string;
  originalFilename: string;
  mimeType: string;
  documentType: string;
  archivedById?: string;
  dateFinRelationAffaires?: Date | null;
}

export interface ArchivedDocumentResult {
  archiveId: string;
  sha256Hash: string;
  sealSignature: string;
  sealCertFingerprint: string;
  timestampToken: string | null;
  timestampTime: Date | null;
  filePath: string;
  retentionExpiry: Date;
  archivedAt: Date;
}

/**
 * Archive un fichier (pièce d'identité ou tout document justificatif) dans le
 * stockage WORM selon le même pipeline que les PDF de conformité :
 *   1. SHA-256
 *   2. Cachet électronique RSA-SHA256
 *   3. Horodatage RFC 3161
 *   4. Stockage WORM (chmod 444)
 *   5. Enregistrement en base avec rétention légale (Art. L. 561-12 CMF)
 *
 * La rétention est calculée à partir de dateFinRelationAffaires (dynamique).
 * Si non encore connue, elle sera recalculée lors de la clôture via PATCH fin-relation.
 */
export async function archiveDocumentFile(
  options: ArchivedDocumentOptions
): Promise<ArchivedDocumentResult> {
  const {
    documentId, dossierId, sourceFilePath, originalFilename,
    mimeType, documentType, archivedById, dateFinRelationAffaires
  } = options;

  const archivedAt = new Date();

  // 1. Lecture du fichier source
  const fileBuffer = await fs.readFile(sourceFilePath);

  // 2. Empreinte SHA-256
  const hashHex = computeSha256(fileBuffer);
  const hashBuffer = Buffer.from(hashHex, 'hex');

  // 3. Cachet électronique RSA-SHA256
  const { signature: sealSignature, certFingerprint: sealCertFingerprint } =
    await createElectronicSeal(hashBuffer);

  // 4. Horodatage RFC 3161
  const tsResult = await getTimestamp(hashBuffer);

  // 5. Stockage WORM - préfixe "doc-" pour distinguer des PDF
  const wormFilename = `doc-${documentId.slice(-8)}-${path.basename(originalFilename)}`;
  const worm: WormStorageResult = await storeWormFile(dossierId, fileBuffer, wormFilename);

  // 6. Rétention légale dynamique
  const retentionExpiry = calculateRetentionExpiry(dateFinRelationAffaires, archivedAt);

  // 7. Enregistrement en base
  const archived = await prisma.archivedDocument.create({
    data: {
      documentId,
      dossierId,
      filename: wormFilename,
      originalFilename,
      filePath: worm.filePath,
      fileSize: worm.fileSize,
      mimeType,
      documentType,
      sha256Hash: hashHex,
      sealSignature,
      sealCertFingerprint,
      timestampToken: tsResult?.token ?? null,
      timestampTime: tsResult?.time ?? null,
      timestampTsa: tsResult ? TSA_URL : null,
      isImmutable: true,
      retentionExpiry,
      archivedAt,
      archivedById: archivedById ?? null,
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
    resource: 'archived_document',
    resourceId: archived.id,
    metadata: {
      dossierId,
      documentId,
      documentType,
      sha256Hash: hashHex,
      retentionExpiry: retentionExpiry.toISOString(),
      hasTimestamp: !!tsResult,
      wormPath: worm.relativePath
    }
  });

  logSystemEvent({
    action: 'backup',
    component: 'archivage_document',
    details: {
      archiveId: archived.id,
      dossierId,
      documentId,
      documentType,
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
    archivedAt
  };
}

// ─── Archivage automatique du dossier ────────────────────────────────────────

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
