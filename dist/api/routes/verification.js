"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const identityVerificationService_1 = require("../../services/identityVerificationService");
const logger_1 = require("../../utils/logger");
const router = (0, express_1.Router)();
const identityInputSchema = zod_1.z.object({
    nom: zod_1.z.string().min(1, 'Nom requis'),
    prenom: zod_1.z.string().min(1, 'Prénom requis'),
    dateNaissance: zod_1.z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'Format DD/MM/YYYY'),
    nationalite: zod_1.z.string().default(''),
    numeroDocument: zod_1.z.string().min(1, 'Numéro de document requis'),
    dateExpiration: zod_1.z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'Format DD/MM/YYYY'),
    docType: zod_1.z.enum(['cni', 'passeport']).default('cni'),
    dossierId: zod_1.z.string().optional(),
});
// POST /api/verification/identity
// Runs all open-source identity checks in parallel and returns results
router.post('/identity', auth_1.authenticateToken, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const input = identityInputSchema.parse(req.body);
    if (!input.nom || !input.prenom) {
        throw new errorHandler_1.ValidationError('Nom et prénom requis pour la vérification');
    }
    const results = await (0, identityVerificationService_1.verifyIdentity)(input);
    const alertCount = results.filter(r => r.status === 'alert').length;
    const warningCount = results.filter(r => r.status === 'warning').length;
    (0, logger_1.logAuditEvent)({
        userId: req.user.id,
        action: 'CREATE',
        resource: 'identity_verification',
        resourceId: input.dossierId ?? 'unknown',
        newValues: { nom: input.nom, prenom: input.prenom, alertCount, warningCount },
        ipAddress: req.ip,
        metadata: { docType: input.docType, checksRun: results.length },
    });
    res.json({
        success: true,
        data: {
            identity: {
                nom: input.nom,
                prenom: input.prenom,
                dateNaissance: input.dateNaissance,
                nationalite: input.nationalite,
                numeroDocument: input.numeroDocument,
                dateExpiration: input.dateExpiration,
                docType: input.docType,
            },
            results,
            summary: {
                total: results.length,
                alerts: alertCount,
                warnings: warningCount,
                errors: results.filter(r => r.status === 'error').length,
                clear: results.filter(r => r.status === 'clear').length,
                riskLevel: alertCount > 0 ? 'high' : warningCount > 0 ? 'medium' : 'low',
            },
        },
    });
}));
exports.default = router;
//# sourceMappingURL=verification.js.map