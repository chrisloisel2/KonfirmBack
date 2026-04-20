import { Router, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ValidationError } from '../../middleware/errorHandler';
import { authenticateToken, AuthenticatedRequest } from '../../middleware/auth';
import { verifyIdentity } from '../../services/identityVerificationService';
import { logAuditEvent } from '../../utils/logger';

const router = Router();

const identityInputSchema = z.object({
  nom:            z.string().min(1, 'Nom requis'),
  prenom:         z.string().min(1, 'Prénom requis'),
  dateNaissance:  z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'Format DD/MM/YYYY'),
  nationalite:    z.string().default(''),
  numeroDocument: z.string().min(1, 'Numéro de document requis'),
  dateExpiration: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'Format DD/MM/YYYY'),
  docType:        z.enum(['cni', 'passeport']).default('cni'),
  dossierId:      z.string().optional(),
});

// POST /api/verification/identity
// Runs all open-source identity checks in parallel and returns results
router.post('/identity',
  authenticateToken,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const input = identityInputSchema.parse(req.body);

    if (!input.nom || !input.prenom) {
      throw new ValidationError('Nom et prénom requis pour la vérification');
    }

    const results = await verifyIdentity(input);

    const alertCount   = results.filter(r => r.status === 'alert').length;
    const warningCount = results.filter(r => r.status === 'warning').length;

    logAuditEvent({
      userId:     req.user!.id,
      action:     'CREATE',
      resource:   'identity_verification',
      resourceId: input.dossierId ?? 'unknown',
      newValues:  { nom: input.nom, prenom: input.prenom, alertCount, warningCount },
      ipAddress:  req.ip,
      metadata:   { docType: input.docType, checksRun: results.length },
    });

    res.json({
      success: true,
      data: {
        identity: {
          nom:            input.nom,
          prenom:         input.prenom,
          dateNaissance:  input.dateNaissance,
          nationalite:    input.nationalite,
          numeroDocument: input.numeroDocument,
          dateExpiration: input.dateExpiration,
          docType:        input.docType,
        },
        results,
        summary: {
          total:    results.length,
          alerts:   alertCount,
          warnings: warningCount,
          errors:   results.filter(r => r.status === 'error').length,
          clear:    results.filter(r => r.status === 'clear').length,
          riskLevel: alertCount > 0 ? 'high' : warningCount > 0 ? 'medium' : 'low',
        },
      },
    });
  })
);

export default router;
