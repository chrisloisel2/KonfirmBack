"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../../lib/prisma"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const promises_1 = __importDefault(require("fs/promises"));
const zod_1 = require("zod");
const tesseract_js_1 = __importDefault(require("tesseract.js"));
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const logger_1 = require("../../utils/logger");
const ocrService_1 = require("../../services/ocrService");
const router = (0, express_1.Router)();
// Configuration du stockage des fichiers
const storage = multer_1.default.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = process.env.UPLOAD_DIR || './uploads';
        const dossierId = req.params.dossierId;
        const fullPath = path_1.default.join(uploadDir, 'dossiers', dossierId);
        try {
            await promises_1.default.mkdir(fullPath, { recursive: true });
            cb(null, fullPath);
        }
        catch (error) {
            cb(error, '');
        }
    },
    filename: (req, file, cb) => {
        // Génération d'un nom unique pour éviter les conflits
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path_1.default.extname(file.originalname);
        const name = path_1.default.basename(file.originalname, ext);
        cb(null, `${name}-${uniqueSuffix}${ext}`);
    }
});
// Configuration de multer avec validation
const upload = (0, multer_1.default)({
    storage,
    limits: {
        fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760'), // 10MB par défaut
        files: 5 // Maximum 5 fichiers par upload
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = (process.env.ALLOWED_FILE_TYPES ||
            'image/jpeg,image/png,image/gif,application/pdf,text/plain').split(',');
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        }
        else {
            cb(new errorHandler_1.ValidationError(`Type de fichier non autorisé: ${file.mimetype}. Types autorisés: ${allowedTypes.join(', ')}`));
        }
    }
});
// Multer dédié pour extract-identity : stockage temporaire, tous formats image acceptés
const uploadOCR = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: (_req, _file, cb) => cb(null, os_1.default.tmpdir()),
        filename: (_req, file, cb) => {
            const ext = path_1.default.extname(file.originalname) || '.jpg';
            cb(null, `ocr_${Date.now()}${ext}`);
        },
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff'].includes(file.mimetype);
        ok ? cb(null, true) : cb(new errorHandler_1.ValidationError(`Type non supporté pour OCR: ${file.mimetype}`));
    },
});
// Validation schemas
const documentMetadataSchema = zod_1.z.object({
    type: zod_1.z.enum(['IDENTITE', 'JUSTIFICATIF_DOMICILE', 'JUSTIFICATIF_REVENUS', 'RIB', 'ATTESTATION_EMPLOYEUR', 'AUTRES']),
    description: zod_1.z.string().optional()
});
// Fonction OCR avec Tesseract
async function performOCR(filePath, mimeType) {
    try {
        // OCR seulement pour les images et PDF (pour PDF, on utiliserait un autre outil)
        if (!mimeType.startsWith('image/')) {
            return {
                text: '',
                metadata: {
                    error: 'OCR non supporté pour ce type de fichier',
                    mimeType
                }
            };
        }
        const ocrLanguages = process.env.OCR_LANGUAGES || 'fra+eng';
        const confidenceThreshold = parseFloat(process.env.OCR_CONFIDENCE_THRESHOLD || '0.7');
        const { data } = await tesseract_js_1.default.recognize(filePath, ocrLanguages, {
            logger: m => {
                if (m.status === 'recognizing text') {
                    (0, logger_1.logSystemEvent)({
                        action: 'ocr_progress',
                        component: 'tesseract',
                        details: { progress: m.progress },
                        severity: 'info'
                    });
                }
            }
        });
        // Filtrage du texte par confiance
        const filteredText = data.words
            .filter(word => word.confidence >= confidenceThreshold * 100)
            .map(word => word.text)
            .join(' ');
        return {
            text: filteredText,
            metadata: {
                confidence: data.confidence,
                wordsTotal: data.words.length,
                wordsFiltered: data.words.filter(w => w.confidence >= confidenceThreshold * 100).length,
                languages: ocrLanguages,
                threshold: confidenceThreshold,
                paragraphs: data.paragraphs.length,
                lines: data.lines.length
            }
        };
    }
    catch (error) {
        (0, logger_1.logSystemEvent)({
            action: 'ocr_error',
            component: 'tesseract',
            details: { error: error instanceof Error ? error.message : 'Unknown error', filePath },
            severity: 'error'
        });
        return {
            text: '',
            metadata: {
                error: error instanceof Error ? error.message : 'Erreur OCR inconnue'
            }
        };
    }
}
// POST /api/documents/extract-identity-base64 — fallback web : image en base64 JSON
router.post('/extract-identity-base64', auth_1.authenticateToken, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { image, docType: rawDocType } = req.body;
    if (!image || typeof image !== 'string')
        throw new errorHandler_1.ValidationError('Champ "image" base64 manquant');
    const docType = zod_1.z.enum(['cni', 'passeport']).default('cni').parse(rawDocType);
    // Décoder et écrire dans un fichier temporaire
    const tmpPath = path_1.default.join(os_1.default.tmpdir(), `ocr_b64_${Date.now()}.jpg`);
    await promises_1.default.writeFile(tmpPath, Buffer.from(image, 'base64'));
    try {
        const identityData = await (0, ocrService_1.extractIdentityData)(tmpPath, docType);
        res.json({
            success: true,
            data: identityData,
            message: identityData.confidence > 0
                ? `Extraction base64 via ${identityData.source} (${Math.round(identityData.confidence * 100)}%)`
                : 'Extraction impossible — saisie manuelle requise',
        });
    }
    finally {
        await promises_1.default.unlink(tmpPath).catch(() => { });
    }
}));
// POST /api/documents/extract-identity - OCR extraction from identity document image
// Accepts a single image file + docType ('cni' | 'passeport')
// Returns structured IdentityData (nom, prenom, dateNaissance, etc.)
router.post('/extract-identity', auth_1.authenticateToken, uploadOCR.single('image'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const file = req.file;
    if (!file)
        throw new errorHandler_1.ValidationError('Aucune image fournie');
    const docType = zod_1.z.enum(['cni', 'passeport']).default('cni').parse(req.body.docType);
    try {
        const identityData = await (0, ocrService_1.extractIdentityData)(file.path, docType);
        (0, logger_1.logSystemEvent)({
            action: 'ocr_progress',
            component: 'extract_identity_route',
            details: {
                source: identityData.source,
                confidence: identityData.confidence,
                hasData: !!identityData.nom,
                docType,
            },
            severity: 'info',
        });
        res.json({
            success: true,
            data: identityData,
            message: identityData.confidence > 0
                ? `Extraction réussie via ${identityData.source} (confiance: ${Math.round(identityData.confidence * 100)}%)`
                : 'Extraction impossible — saisie manuelle requise',
        });
    }
    finally {
        // Clean up temp upload
        await promises_1.default.unlink(file.path).catch(() => { });
    }
}));
// POST /api/documents/dossiers/:dossierId/upload - Upload de documents
router.post('/dossiers/:dossierId/upload', auth_1.authenticateToken, auth_1.requireDossierAccess, upload.array('documents', 5), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { dossierId } = req.params;
    const files = req.files;
    const userId = req.user.id;
    if (!files || files.length === 0) {
        throw new errorHandler_1.ValidationError('Aucun fichier fourni');
    }
    // Vérification que le dossier existe
    const dossier = await prisma_1.default.dossier.findUnique({
        where: { id: dossierId },
        select: { id: true, numero: true }
    });
    if (!dossier) {
        throw new errorHandler_1.ValidationError('Dossier non trouvé');
    }
    const uploadedDocuments = [];
    for (const file of files) {
        try {
            // Métadonnées du document depuis le form-data
            const metadata = req.body[`metadata_${file.originalname}`]
                ? JSON.parse(req.body[`metadata_${file.originalname}`])
                : {};
            const validatedMetadata = documentMetadataSchema.parse(metadata);
            // Traitement OCR si applicable
            const ocrResult = await performOCR(file.path, file.mimetype);
            // Enregistrement en base de données
            const document = await prisma_1.default.document.create({
                data: {
                    dossierId,
                    uploadedById: userId,
                    fileName: file.filename,
                    originalName: file.originalname,
                    fileSize: file.size,
                    mimeType: file.mimetype,
                    filePath: file.path,
                    type: validatedMetadata.type,
                    description: validatedMetadata.description,
                    ocrText: ocrResult.text,
                    ocrMetadata: ocrResult.metadata
                }
            });
            uploadedDocuments.push({
                id: document.id,
                fileName: document.fileName,
                originalName: document.originalName,
                type: document.type,
                fileSize: document.fileSize,
                hasOcrText: !!ocrResult.text,
                ocrConfidence: ocrResult.metadata.confidence || null
            });
            (0, logger_1.logDossierEvent)({
                action: 'document_uploaded',
                dossierId,
                userId,
                details: {
                    documentId: document.id,
                    fileName: file.originalname,
                    fileSize: file.size,
                    type: validatedMetadata.type,
                    hasOcr: !!ocrResult.text
                }
            });
            (0, logger_1.logAuditEvent)({
                userId,
                action: 'CREATE',
                resource: 'document',
                resourceId: document.id,
                newValues: document,
                ipAddress: req.ip,
                metadata: { dossierId }
            });
        }
        catch (error) {
            // Suppression du fichier en cas d'erreur
            try {
                await promises_1.default.unlink(file.path);
            }
            catch (unlinkError) {
                (0, logger_1.logSystemEvent)({
                    action: 'file_cleanup_error',
                    component: 'document_upload',
                    details: { filePath: file.path, error: unlinkError },
                    severity: 'warning'
                });
            }
            (0, logger_1.logSystemEvent)({
                action: 'document_upload_error',
                component: 'document_upload',
                details: {
                    fileName: file.originalname,
                    error: error instanceof Error ? error.message : 'Unknown error'
                },
                severity: 'error'
            });
            throw error;
        }
    }
    res.status(201).json({
        success: true,
        data: {
            documents: uploadedDocuments,
            totalUpploaded: uploadedDocuments.length
        },
        message: `${uploadedDocuments.length} document(s) uploadé(s) avec succès`
    });
}));
// GET /api/documents/dossiers/:dossierId - Liste des documents d'un dossier
router.get('/dossiers/:dossierId', auth_1.authenticateToken, auth_1.requireDossierAccess, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { dossierId } = req.params;
    const documents = await prisma_1.default.document.findMany({
        where: { dossierId },
        include: {
            uploadedBy: {
                select: { id: true, firstName: true, lastName: true }
            }
        },
        orderBy: { createdAt: 'desc' }
    });
    (0, logger_1.logAuditEvent)({
        userId: req.user.id,
        action: 'READ',
        resource: 'documents_list',
        resourceId: dossierId,
        ipAddress: req.ip,
        metadata: { documentCount: documents.length }
    });
    res.json({
        success: true,
        data: { documents }
    });
}));
// GET /api/documents/:documentId - Détails d'un document
router.get('/:documentId', auth_1.authenticateToken, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { documentId } = req.params;
    const document = await prisma_1.default.document.findUnique({
        where: { id: documentId },
        include: {
            dossier: {
                select: {
                    id: true,
                    numero: true,
                    createdById: true,
                    assignedToId: true
                }
            },
            uploadedBy: {
                select: { id: true, firstName: true, lastName: true }
            }
        }
    });
    if (!document) {
        throw new errorHandler_1.ValidationError('Document non trouvé');
    }
    // Vérification des permissions sur le dossier
    const userId = req.user.id;
    const userRole = req.user.role;
    const hasAccess = (document.dossier.createdById === userId ||
        document.dossier.assignedToId === userId ||
        ['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(userRole));
    if (!hasAccess) {
        throw new errorHandler_1.ValidationError('Accès refusé à ce document');
    }
    (0, logger_1.logAuditEvent)({
        userId: req.user.id,
        action: 'READ',
        resource: 'document',
        resourceId: documentId,
        ipAddress: req.ip,
        metadata: { dossierId: document.dossierId }
    });
    res.json({
        success: true,
        data: { document }
    });
}));
// GET /api/documents/:documentId/download - Téléchargement d'un document
router.get('/:documentId/download', auth_1.authenticateToken, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { documentId } = req.params;
    const document = await prisma_1.default.document.findUnique({
        where: { id: documentId },
        include: {
            dossier: {
                select: {
                    id: true,
                    createdById: true,
                    assignedToId: true
                }
            }
        }
    });
    if (!document) {
        throw new errorHandler_1.ValidationError('Document non trouvé');
    }
    // Vérification des permissions
    const userId = req.user.id;
    const userRole = req.user.role;
    const hasAccess = (document.dossier.createdById === userId ||
        document.dossier.assignedToId === userId ||
        ['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(userRole));
    if (!hasAccess) {
        throw new errorHandler_1.ValidationError('Accès refusé à ce document');
    }
    // Vérification de l'existence du fichier
    try {
        await promises_1.default.access(document.filePath);
    }
    catch {
        throw new errorHandler_1.ValidationError('Fichier non trouvé sur le serveur');
    }
    (0, logger_1.logAuditEvent)({
        userId: req.user.id,
        action: 'READ',
        resource: 'document_download',
        resourceId: documentId,
        ipAddress: req.ip,
        metadata: {
            dossierId: document.dossierId,
            fileName: document.originalName
        }
    });
    res.setHeader('Content-Disposition', `attachment; filename="${document.originalName}"`);
    res.setHeader('Content-Type', document.mimeType);
    res.sendFile(path_1.default.resolve(document.filePath));
}));
// PATCH /api/documents/:documentId/verify - Validation d'un document
router.patch('/:documentId/verify', auth_1.authenticateToken, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { documentId } = req.params;
    const { verified } = zod_1.z.object({
        verified: zod_1.z.boolean()
    }).parse(req.body);
    const document = await prisma_1.default.document.findUnique({
        where: { id: documentId },
        include: {
            dossier: {
                select: {
                    id: true,
                    createdById: true,
                    assignedToId: true
                }
            }
        }
    });
    if (!document) {
        throw new errorHandler_1.ValidationError('Document non trouvé');
    }
    // Vérification des permissions
    const userId = req.user.id;
    const userRole = req.user.role;
    const hasAccess = (document.dossier.createdById === userId ||
        document.dossier.assignedToId === userId ||
        ['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(userRole));
    if (!hasAccess) {
        throw new errorHandler_1.ValidationError('Accès refusé à ce document');
    }
    const updatedDocument = await prisma_1.default.document.update({
        where: { id: documentId },
        data: {
            isVerified: verified,
            verifiedAt: verified ? new Date() : null,
            verifiedById: verified ? userId : null
        }
    });
    (0, logger_1.logDossierEvent)({
        action: verified ? 'document_verified' : 'document_unverified',
        dossierId: document.dossierId,
        userId,
        details: {
            documentId,
            fileName: document.originalName
        }
    });
    (0, logger_1.logAuditEvent)({
        userId,
        action: 'UPDATE',
        resource: 'document',
        resourceId: documentId,
        oldValues: { isVerified: document.isVerified },
        newValues: { isVerified: verified },
        ipAddress: req.ip,
        metadata: { dossierId: document.dossierId }
    });
    res.json({
        success: true,
        data: { document: updatedDocument },
        message: verified ? 'Document vérifié' : 'Vérification du document annulée'
    });
}));
// POST /api/documents/:documentId/reprocess-ocr - Relancer l'OCR
router.post('/:documentId/reprocess-ocr', auth_1.authenticateToken, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { documentId } = req.params;
    const document = await prisma_1.default.document.findUnique({
        where: { id: documentId },
        include: {
            dossier: {
                select: {
                    id: true,
                    createdById: true,
                    assignedToId: true
                }
            }
        }
    });
    if (!document) {
        throw new errorHandler_1.ValidationError('Document non trouvé');
    }
    // Vérification des permissions
    const userId = req.user.id;
    const userRole = req.user.role;
    const hasAccess = (document.dossier.createdById === userId ||
        document.dossier.assignedToId === userId ||
        ['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(userRole));
    if (!hasAccess) {
        throw new errorHandler_1.ValidationError('Accès refusé à ce document');
    }
    // Vérification que le fichier existe
    try {
        await promises_1.default.access(document.filePath);
    }
    catch {
        throw new errorHandler_1.ValidationError('Fichier non trouvé sur le serveur');
    }
    // Relancer l'OCR
    const ocrResult = await performOCR(document.filePath, document.mimeType);
    // Mise à jour du document avec les nouveaux résultats OCR
    const updatedDocument = await prisma_1.default.document.update({
        where: { id: documentId },
        data: {
            ocrText: ocrResult.text,
            ocrMetadata: ocrResult.metadata
        }
    });
    (0, logger_1.logDossierEvent)({
        action: 'document_ocr_reprocessed',
        dossierId: document.dossierId,
        userId,
        details: {
            documentId,
            fileName: document.originalName,
            hasNewText: !!ocrResult.text,
            confidence: ocrResult.metadata.confidence
        }
    });
    res.json({
        success: true,
        data: {
            document: updatedDocument,
            ocrResult: {
                hasText: !!ocrResult.text,
                confidence: ocrResult.metadata.confidence,
                wordCount: ocrResult.metadata.wordsFiltered
            }
        },
        message: 'OCR retraité avec succès'
    });
}));
exports.default = router;
//# sourceMappingURL=documents.js.map