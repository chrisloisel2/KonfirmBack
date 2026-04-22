import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import prisma from '../../lib/prisma';
import {
  AppError,
  ValidationError,
  asyncHandler
} from '../../middleware/errorHandler';
import {
  authenticateToken,
  requireMinimumRole,
  AuthenticatedRequest
} from '../../middleware/auth';
import { logAuditEvent, logSystemEvent } from '../../utils/logger';
import { archivePdf, archiveDossier, generateCertificatPdf } from '../../services/archivageService';
import {
  verifyFileIntegrity,
  readWormFile,
  deleteExpiredWormFile,
  getWormStorageStats,
  isRetentionExpired
} from '../../services/wormStorageService';

const router = Router();

// Multer mémoire pour réception des PDFs (pas de stockage temporaire)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new ValidationError('Seuls les fichiers PDF sont acceptés'));
  }
});

// ─── POST /api/archivage/:dossierId/pdf ───────────────────────────────────────
// Soumettre un PDF généré côté client pour archivage complet.
router.post(
  '/:dossierId/pdf',
  authenticateToken,
  upload.single('pdf'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dossierId } = req.params;
    const userId = req.user!.id;

    const dossier = await prisma.dossier.findUnique({
      where: { id: dossierId },
      select: {
        id: true, numero: true, status: true,
        dateFinRelationAffaires: true, createdById: true
      }
    });
    if (!dossier) throw new AppError('Dossier introuvable', 404);

    // Contrôle d'accès : seul le créateur, l'assigné ou REFERENT+
    const user = req.user!;
    const isOwner = dossier.createdById === userId;
    const isElevated = ['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(user.role);
    if (!isOwner && !isElevated) {
      throw new AppError('Accès non autorisé à ce dossier', 403);
    }

    if (!req.file) throw new ValidationError('Fichier PDF manquant');

    const result = await archivePdf({
      dossierId,
      pdfBuffer: req.file.buffer,
      originalFilename: req.file.originalname,
      archivedById: userId,
      triggerStatus: `UPLOAD_${dossier.status}`,
      dateFinRelationAffaires: dossier.dateFinRelationAffaires
    });

    res.status(201).json({
      success: true,
      data: {
        archiveId: result.archiveId,
        sha256Hash: result.sha256Hash,
        sealCertFingerprint: result.sealCertFingerprint,
        hasTimestamp: !!result.timestampToken,
        timestampTime: result.timestampTime,
        retentionExpiry: result.retentionExpiry,
        archivedAt: result.archivedAt,
        isPdfa: result.isPdfa
      }
    });
  })
);

// ─── POST /api/archivage/:dossierId/generer ───────────────────────────────────
// Déclencher manuellement la génération + archivage côté serveur.
router.post(
  '/:dossierId/generer',
  authenticateToken,
  requireMinimumRole('REFERENT'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dossierId } = req.params;
    const userId = req.user!.id;

    const dossier = await prisma.dossier.findUnique({
      where: { id: dossierId },
      select: { id: true, status: true }
    });
    if (!dossier) throw new AppError('Dossier introuvable', 404);

    const result = await archiveDossier(dossierId, userId, `MANUEL_${dossier.status}`);

    res.status(201).json({
      success: true,
      data: {
        archiveId: result.archiveId,
        sha256Hash: result.sha256Hash,
        sealCertFingerprint: result.sealCertFingerprint,
        hasTimestamp: !!result.timestampToken,
        timestampTime: result.timestampTime,
        retentionExpiry: result.retentionExpiry,
        archivedAt: result.archivedAt,
        isPdfa: result.isPdfa
      }
    });
  })
);

// ─── GET /api/archivage/:dossierId ────────────────────────────────────────────
// Liste les archives d'un dossier.
router.get(
  '/:dossierId',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dossierId } = req.params;

    const dossier = await prisma.dossier.findUnique({
      where: { id: dossierId },
      select: { id: true, createdById: true }
    });
    if (!dossier) throw new AppError('Dossier introuvable', 404);

    const user = req.user!;
    const isOwner = dossier.createdById === user.id;
    const isElevated = ['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(user.role);
    if (!isOwner && !isElevated) throw new AppError('Accès non autorisé', 403);

    const archives = await prisma.archivedPdf.findMany({
      where: { dossierId },
      orderBy: { archivedAt: 'desc' },
      select: {
        id: true,
        filename: true,
        originalFilename: true,
        fileSize: true,
        sha256Hash: true,
        sealCertFingerprint: true,
        timestampTime: true,
        timestampTsa: true,
        isPdfa: true,
        retentionExpiry: true,
        isImmutable: true,
        archivedAt: true,
        triggerStatus: true
      }
    });

    res.json({
      success: true,
      data: {
        archives,
        total: archives.length
      }
    });
  })
);

// ─── GET /api/archivage/:dossierId/:archiveId/verifier ────────────────────────
// Vérifie l'intégrité d'une archive (recalcul SHA-256).
router.get(
  '/:dossierId/:archiveId/verifier',
  authenticateToken,
  requireMinimumRole('REFERENT'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dossierId, archiveId } = req.params;
    const userId = req.user!.id;

    const archive = await prisma.archivedPdf.findFirst({
      where: { id: archiveId, dossierId }
    });
    if (!archive) throw new AppError('Archive introuvable', 404);

    const isValid = await verifyFileIntegrity(archive.filePath, archive.sha256Hash);

    logAuditEvent({
      userId,
      action: 'READ',
      resource: 'archived_pdf',
      resourceId: archiveId,
      metadata: { dossierId, integrityCheck: isValid }
    });

    res.json({
      success: true,
      data: {
        archiveId,
        dossierId,
        filename: archive.filename,
        sha256Hash: archive.sha256Hash,
        integrityValid: isValid,
        retentionExpiry: archive.retentionExpiry,
        retentionExpired: isRetentionExpired(archive.retentionExpiry),
        verifiedAt: new Date().toISOString()
      }
    });
  })
);

// ─── GET /api/archivage/:dossierId/:archiveId/telecharger ─────────────────────
// Télécharge un fichier archivé (lecture seule, traçée).
router.get(
  '/:dossierId/:archiveId/telecharger',
  authenticateToken,
  requireMinimumRole('REFERENT'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dossierId, archiveId } = req.params;
    const userId = req.user!.id;

    const archive = await prisma.archivedPdf.findFirst({
      where: { id: archiveId, dossierId }
    });
    if (!archive) throw new AppError('Archive introuvable', 404);

    const fileBuffer = await readWormFile(archive.filePath);

    logAuditEvent({
      userId,
      action: 'READ',
      resource: 'archived_pdf_download',
      resourceId: archiveId,
      metadata: {
        dossierId,
        filename: archive.filename,
        sha256Hash: archive.sha256Hash,
        ip: req.ip
      }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    res.setHeader('X-SHA256', archive.sha256Hash);
    res.setHeader('X-Seal-Fingerprint', archive.sealCertFingerprint);
    res.setHeader('X-Retention-Expiry', archive.retentionExpiry.toISOString());
    res.setHeader('X-Is-Immutable', 'true');
    res.send(fileBuffer);
  })
);

// ─── DELETE /api/archivage/:dossierId/:archiveId ──────────────────────────────
// Suppression uniquement si durée légale expirée.
router.delete(
  '/:dossierId/:archiveId',
  authenticateToken,
  requireMinimumRole('ADMIN'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dossierId, archiveId } = req.params;
    const userId = req.user!.id;

    const archive = await prisma.archivedPdf.findFirst({
      where: { id: archiveId, dossierId }
    });
    if (!archive) throw new AppError('Archive introuvable', 404);

    // deleteExpiredWormFile lance une erreur si rétention non expirée
    await deleteExpiredWormFile(archive.filePath, archive.retentionExpiry);

    await prisma.archivedPdf.delete({ where: { id: archiveId } });

    logAuditEvent({
      userId,
      action: 'DELETE',
      resource: 'archived_pdf',
      resourceId: archiveId,
      metadata: {
        dossierId,
        filename: archive.filename,
        retentionExpiry: archive.retentionExpiry.toISOString(),
        purgedAt: new Date().toISOString()
      }
    });

    res.json({
      success: true,
      data: { message: 'Archive purgée après expiration légale de conservation.' }
    });
  })
);

// ─── PATCH /api/archivage/:dossierId/fin-relation ─────────────────────────────
// Enregistre la date de cessation de la relation d'affaires (déclenche le calcul de rétention).
router.patch(
  '/:dossierId/fin-relation',
  authenticateToken,
  requireMinimumRole('REFERENT'),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dossierId } = req.params;
    const userId = req.user!.id;

    const { dateFinRelationAffaires } = req.body;
    if (!dateFinRelationAffaires) {
      throw new ValidationError('dateFinRelationAffaires requis (ISO 8601)');
    }

    const date = new Date(dateFinRelationAffaires);
    if (isNaN(date.getTime())) {
      throw new ValidationError('Format de date invalide');
    }

    const dossier = await prisma.dossier.update({
      where: { id: dossierId },
      data: { dateFinRelationAffaires: date },
      select: { id: true, numero: true, dateFinRelationAffaires: true }
    });

    // Recalcul de la rétention sur toutes les archives du dossier
    const retentionExpiry = new Date(date);
    retentionExpiry.setFullYear(retentionExpiry.getFullYear() + 5);

    await prisma.archivedPdf.updateMany({
      where: { dossierId },
      data: { retentionExpiry }
    });

    logAuditEvent({
      userId,
      action: 'UPDATE',
      resource: 'dossier_fin_relation',
      resourceId: dossierId,
      newValues: { dateFinRelationAffaires: date, retentionExpiry }
    });

    res.json({
      success: true,
      data: {
        dossierId,
        numeroDossier: dossier.numero,
        dateFinRelationAffaires: date,
        retentionExpiry,
        message: `Conservation légale calculée jusqu'au ${retentionExpiry.toLocaleDateString('fr-FR')}`
      }
    });
  })
);

// ─── GET /api/archivage/:dossierId/:archiveId/certificat ──────────────────────
// Génère et retourne le Certificat de Conformité d'Archivage (PDF officiel).
router.get(
  '/:dossierId/:archiveId/certificat',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dossierId, archiveId } = req.params;
    const userId = req.user!.id;

    const archive = await prisma.archivedPdf.findFirst({
      where: { id: archiveId, dossierId },
      include: { dossier: { include: { client: true } } }
    });
    if (!archive) throw new AppError('Archive introuvable', 404);

    // Vérification d'intégrité en temps réel pour le certificat
    const integrityOk = await verifyFileIntegrity(archive.filePath, archive.sha256Hash);

    const certBuffer = await generateCertificatPdf({
      archive,
      dossier: archive.dossier,
      client: archive.dossier.client,
      integrityOk,
      requestedBy: `${req.user!.firstName ?? ''} ${req.user!.lastName ?? ''}`.trim(),
      requestedAt: new Date()
    });

    logAuditEvent({
      userId,
      action: 'EXPORT',
      resource: 'certificat_conformite',
      resourceId: archiveId,
      metadata: { dossierId, integrityOk, ip: req.ip }
    });

    const certFilename = `certificat-archivage-${archive.dossier.numero}-${archiveId.slice(-8)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${certFilename}"`);
    res.setHeader('X-Integrity-Valid', String(integrityOk));
    res.setHeader('X-SHA256', archive.sha256Hash);
    res.send(certBuffer);
  })
);

// ─── GET /api/archivage/stats/worm ────────────────────────────────────────────
// Statistiques du stockage WORM (ADMIN uniquement).
router.get(
  '/stats/worm',
  authenticateToken,
  requireMinimumRole('ADMIN'),
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const stats = await getWormStorageStats();
    const dbCount = await prisma.archivedPdf.count();
    const expiringCount = await prisma.archivedPdf.count({
      where: { retentionExpiry: { lte: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) } }
    });

    res.json({
      success: true,
      data: {
        wormStorage: stats,
        database: {
          totalArchives: dbCount,
          expiringWithin90Days: expiringCount
        }
      }
    });
  })
);

export default router;
