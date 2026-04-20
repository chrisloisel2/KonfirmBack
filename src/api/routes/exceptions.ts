import { Router, Response } from 'express';
import prisma from '../../lib/prisma';
import { z } from 'zod';
import {
	AppError,
	ValidationError,
	AuthorizationError,
	asyncHandler
} from '../../middleware/errorHandler';
import {
	authenticateToken,
	requireMinimumRole,
	AuthenticatedRequest
} from '../../middleware/auth';
import {
	logExceptionEvent,
	logAuditEvent
} from '../../utils/logger';

const router = Router();

// Validation schemas
const createExceptionSchema = z.object({
	dossierId: z.string().uuid('ID de dossier invalide'),
	type: z.enum(['PPE_DETECTION', 'SANCTIONS_DETECTION', 'ASSET_FREEZE_DETECTION', 'SCORING_ELEVE', 'DONNEES_INCOMPLETES', 'VERIFICATION_MANUELLE', 'AUTRE']),
	description: z.string().min(10, 'Description trop courte'),
	details: z.any().optional(),
	priority: z.enum(['FAIBLE', 'NORMALE', 'HAUTE', 'CRITIQUE']).default('NORMALE')
});

const updateExceptionSchema = z.object({
	status: z.enum(['EN_ATTENTE', 'EN_COURS_TRAITEMENT', 'RESOLUE', 'ESCALADEE', 'VALIDEE', 'REJETEE']).optional(),
	assignedToId: z.string().uuid().optional(),
	resolution: z.string().optional(),
	escalatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/).optional()
});

const searchExceptionsSchema = z.object({
	page: z.string().regex(/^\d+$/).transform(Number).default(1),
	limit: z.string().regex(/^\d+$/).transform(Number).default(10),
	status: z.string().optional(),
	type: z.string().optional(),
	priority: z.string().optional(),
	assignedToId: z.string().uuid().optional(),
	dossierId: z.string().uuid().optional(),
	sortBy: z.enum(['createdAt', 'updatedAt', 'priority']).default('createdAt'),
	sortOrder: z.enum(['asc', 'desc']).default('desc')
});

// POST /api/exceptions - Créer une nouvelle exception
router.post('/',
	authenticateToken,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const validatedData = createExceptionSchema.parse(req.body);
		const userId = req.user!.id;

		// Vérification que le dossier existe
		const dossier = await prisma.dossier.findUnique({
			where: { id: validatedData.dossierId },
			select: {
				id: true,
				numero: true,
				createdById: true,
				assignedToId: true
			}
		});

		if (!dossier) {
			throw new ValidationError('Dossier non trouvé');
		}

		// Vérification des permissions sur le dossier
		const userRole = req.user!.role;
		const hasAccess = (
			dossier.createdById === userId ||
			dossier.assignedToId === userId ||
			['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(userRole)
		);

		if (!hasAccess) {
			throw new AuthorizationError('Accès refusé à ce dossier');
		}

		// Création de l'exception
		const exception = await prisma.exception.create({
			data: {
				dossierId: validatedData.dossierId,
				type: validatedData.type,
				description: validatedData.description,
				details: validatedData.details,
				priority: validatedData.priority,
				status: 'EN_ATTENTE'
			},
			include: {
				dossier: {
					select: {
						id: true,
						numero: true,
						client: {
							select: { nom: true, prenom: true }
						}
					}
				}
			}
		});

		logExceptionEvent({
			action: 'exception_created',
			dossierId: validatedData.dossierId,
			userId,
			exceptionId: exception.id,
			details: {
				type: validatedData.type,
				priority: validatedData.priority,
				description: validatedData.description
			}
		});

		logAuditEvent({
			userId,
			action: 'CREATE',
			resource: 'exception',
			resourceId: exception.id,
			newValues: exception,
			ipAddress: req.ip,
			metadata: { dossierId: validatedData.dossierId }
		});

		res.status(201).json({
			success: true,
			data: { exception }
		});
	})
);

// GET /api/exceptions - Liste des exceptions avec filtrage
router.get('/',
	authenticateToken,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const params = searchExceptionsSchema.parse(req.query);
		const userId = req.user!.id;
		const userRole = req.user!.role;

		// Construction des filtres basés sur les permissions
		let whereClause: any = {};

		// Filtrage par rôle
		if (userRole === 'CONSEILLER' || userRole === 'CAISSE') {
			// Peut voir seulement les exceptions de ses dossiers ou qui lui sont assignées
			whereClause.OR = [
				{
					dossier: {
						OR: [
							{ createdById: userId },
							{ assignedToId: userId }
						]
					}
				},
				{ assignedToId: userId }
			];
		}
		// REFERENT, RESPONSABLE et ADMIN peuvent voir toutes les exceptions

		// Filtres additionnels
		if (params.status) {
			whereClause.status = params.status;
		}

		if (params.type) {
			whereClause.type = params.type;
		}

		if (params.priority) {
			whereClause.priority = params.priority;
		}

		if (params.assignedToId) {
			whereClause.assignedToId = params.assignedToId;
		}

		if (params.dossierId) {
			whereClause.dossierId = params.dossierId;
		}

		// Calcul de la pagination
		const skip = (params.page - 1) * params.limit;

		// Requête avec pagination
		const [exceptions, total] = await Promise.all([
			prisma.exception.findMany({
				where: whereClause,
				include: {
					dossier: {
						select: {
							id: true,
							numero: true,
							client: {
								select: { nom: true, prenom: true }
							}
						}
					},
					assignedTo: {
						select: { id: true, firstName: true, lastName: true }
					}
				},
				orderBy: { [params.sortBy]: params.sortOrder },
				skip,
				take: params.limit
			}),
			prisma.exception.count({ where: whereClause })
		]);

		const totalPages = Math.ceil(total / params.limit);

		res.json({
			success: true,
			data: {
				exceptions,
				pagination: {
					page: params.page,
					limit: params.limit,
					total,
					totalPages,
					hasNext: params.page < totalPages,
					hasPrev: params.page > 1
				}
			}
		});
	})
);

// GET /api/exceptions/:exceptionId - Détails d'une exception
router.get('/:exceptionId',
	authenticateToken,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { exceptionId } = req.params;
		const userId = req.user!.id;
		const userRole = req.user!.role;

		const exception = await prisma.exception.findUnique({
			where: { id: exceptionId },
			include: {
				dossier: {
					include: {
						client: true,
						createdBy: {
							select: { id: true, firstName: true, lastName: true }
						},
						assignedTo: {
							select: { id: true, firstName: true, lastName: true }
						}
					}
				},
				assignedTo: {
					select: { id: true, firstName: true, lastName: true, role: true }
				}
			}
		});

		if (!exception) {
			throw new ValidationError('Exception non trouvée');
		}

		// Vérification des permissions
		const hasAccess = (
			exception.dossier.createdById === userId ||
			exception.dossier.assignedToId === userId ||
			exception.assignedToId === userId ||
			['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(userRole)
		);

		if (!hasAccess) {
			throw new AuthorizationError('Accès refusé à cette exception');
		}

		logAuditEvent({
			userId: req.user!.id,
			action: 'READ',
			resource: 'exception',
			resourceId: exceptionId,
			ipAddress: req.ip,
			metadata: { dossierId: exception.dossierId }
		});

		res.json({
			success: true,
			data: { exception }
		});
	})
);

// PATCH /api/exceptions/:exceptionId - Mise à jour d'une exception
router.patch('/:exceptionId',
	authenticateToken,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { exceptionId } = req.params;
		const validatedData = updateExceptionSchema.parse(req.body);
		const userId = req.user!.id;
		const userRole = req.user!.role;

		// Récupération de l'exception actuelle
		const currentException = await prisma.exception.findUnique({
			where: { id: exceptionId },
			include: {
				dossier: {
					select: {
						createdById: true,
						assignedToId: true
					}
				}
			}
		});

		if (!currentException) {
			throw new ValidationError('Exception non trouvée');
		}

		// Vérification des permissions
		const hasAccess = (
			currentException.dossier.createdById === userId ||
			currentException.dossier.assignedToId === userId ||
			currentException.assignedToId === userId ||
			['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(userRole)
		);

		if (!hasAccess) {
			throw new AuthorizationError('Accès refusé à cette exception');
		}

		// Vérifications métier pour certaines transitions
		if (validatedData.status) {
			const allowedTransitions: Record<string, string[]> = {
				'EN_ATTENTE': ['EN_COURS_TRAITEMENT', 'ESCALADEE'],
				'EN_COURS_TRAITEMENT': ['RESOLUE', 'ESCALADEE', 'VALIDEE', 'REJETEE'],
				'RESOLUE': [], // Exception résolue ne peut plus changer
				'ESCALADEE': ['EN_COURS_TRAITEMENT', 'VALIDEE', 'REJETEE'],
				'VALIDEE': [], // Exception validée ne peut plus changer
				'REJETEE': ['EN_COURS_TRAITEMENT'] // Peut être remise en traitement
			};

			if (!allowedTransitions[currentException.status]?.includes(validatedData.status)) {
				throw new ValidationError(
					`Transition de statut non autorisée: ${currentException.status} -> ${validatedData.status}`
				);
			}

			// Certaines actions nécessitent des rôles spécifiques
			if (['VALIDEE', 'REJETEE'].includes(validatedData.status) &&
				!['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(userRole)) {
				throw new AuthorizationError('Privilèges insuffisants pour valider/rejeter une exception');
			}
		}

		// Préparation des données de mise à jour
		const updateData: any = { ...validatedData };

		if (validatedData.escalatedAt) {
			updateData.escalatedAt = new Date(validatedData.escalatedAt);
		}

		if (['RESOLUE', 'VALIDEE', 'REJETEE'].includes(validatedData.status || '')) {
			updateData.resolvedAt = new Date();
		}

		// Vérification de l'assignation
		if (validatedData.assignedToId) {
			const targetUser = await prisma.user.findUnique({
				where: { id: validatedData.assignedToId },
				select: { id: true, firstName: true, lastName: true, isActive: true, role: true }
			});

			if (!targetUser || !targetUser.isActive) {
				throw new ValidationError('Utilisateur invalide ou inactif');
			}

			// Seuls les REFERENT, RESPONSABLE et ADMIN peuvent traiter certaines exceptions
			const criticalTypes = ['SANCTIONS_DETECTION', 'ASSET_FREEZE_DETECTION'];
			if (criticalTypes.includes(currentException.type) &&
				!['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(targetUser.role)) {
				throw new ValidationError('Ce type d\'exception nécessite un niveau d\'autorisation élevé');
			}
		}

		// Mise à jour de l'exception
		const updatedException = await prisma.exception.update({
			where: { id: exceptionId },
			data: updateData,
			include: {
				dossier: {
					select: {
						id: true,
						numero: true,
						client: { select: { nom: true, prenom: true } }
					}
				},
				assignedTo: {
					select: { id: true, firstName: true, lastName: true }
				}
			}
		});

		logExceptionEvent({
			action: 'exception_updated',
			dossierId: currentException.dossierId,
			userId,
			exceptionId,
			details: {
				changes: validatedData,
				previousStatus: currentException.status,
				newStatus: updatedException.status
			}
		});

		logAuditEvent({
			userId,
			action: 'UPDATE',
			resource: 'exception',
			resourceId: exceptionId,
			oldValues: currentException,
			newValues: updatedException,
			ipAddress: req.ip,
			metadata: { dossierId: currentException.dossierId }
		});

		res.json({
			success: true,
			data: { exception: updatedException }
		});
	})
);

// POST /api/exceptions/:exceptionId/assign - Assigner une exception
router.post('/:exceptionId/assign',
	authenticateToken,
	requireMinimumRole('REFERENT'),
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { exceptionId } = req.params;
		const { assignToUserId } = z.object({
			assignToUserId: z.string().uuid('ID utilisateur invalide')
		}).parse(req.body);

		const exception = await prisma.exception.findUnique({
			where: { id: exceptionId },
			select: {
				id: true,
				type: true,
				dossierId: true
			}
		});

		if (!exception) {
			throw new ValidationError('Exception non trouvée');
		}

		// Vérification que l'utilisateur cible existe et est actif
		const targetUser = await prisma.user.findUnique({
			where: { id: assignToUserId },
			select: { id: true, firstName: true, lastName: true, isActive: true, role: true }
		});

		if (!targetUser || !targetUser.isActive) {
			throw new ValidationError('Utilisateur invalide ou inactif');
		}

		// Vérification des privilèges pour certaines exceptions critiques
		const criticalTypes = ['SANCTIONS_DETECTION', 'ASSET_FREEZE_DETECTION'];
		if (criticalTypes.includes(exception.type) &&
			!['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(targetUser.role)) {
			throw new ValidationError('Ce type d\'exception nécessite un niveau d\'autorisation élevé');
		}

		const updatedException = await prisma.exception.update({
			where: { id: exceptionId },
			data: {
				assignedToId: assignToUserId,
				status: 'EN_COURS_TRAITEMENT'
			},
			include: {
				assignedTo: { select: { id: true, firstName: true, lastName: true, role: true } }
			}
		});

		logExceptionEvent({
			action: 'exception_assigned',
			dossierId: exception.dossierId,
			userId: req.user!.id,
			exceptionId,
			details: {
				assignedToUserId: assignToUserId,
				assignedToName: `${targetUser.firstName} ${targetUser.lastName}`,
				assignedToRole: targetUser.role
			}
		});

		res.json({
			success: true,
			data: { exception: updatedException },
			message: `Exception assignée à ${targetUser.firstName} ${targetUser.lastName}`
		});
	})
);

// GET /api/exceptions/my-assignments - Mes exceptions assignées
router.get('/my-assignments',
	authenticateToken,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const userId = req.user!.id;

		const exceptions = await prisma.exception.findMany({
			where: {
				assignedToId: userId,
				status: { in: ['EN_ATTENTE', 'EN_COURS_TRAITEMENT'] }
			},
			include: {
				dossier: {
					select: {
						id: true,
						numero: true,
						client: {
							select: { nom: true, prenom: true }
						}
					}
				}
			},
			orderBy: [
				{ priority: 'desc' },
				{ createdAt: 'asc' }
			]
		});

		res.json({
			success: true,
			data: {
				exceptions,
				count: exceptions.length
			}
		});
	})
);

// GET /api/exceptions/stats - Statistiques des exceptions
router.get('/stats',
	authenticateToken,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const userId = req.user!.id;
		const userRole = req.user!.role;

		// Filtrage par permissions
		let whereClause: any = {};
		if (userRole === 'CONSEILLER' || userRole === 'CAISSE') {
			whereClause = {
				OR: [
					{
						dossier: {
							OR: [
								{ createdById: userId },
								{ assignedToId: userId }
							]
						}
					},
					{ assignedToId: userId }
				]
			};
		}

		const [
			totalExceptions,
			distributionParStatut,
			distributionParType,
			distributionParPriorite,
			exceptionsEnAttente,
			exceptionsAssignees
		] = await Promise.all([
			// Total des exceptions
			prisma.exception.count({ where: whereClause }),

			// Distribution par statut
			prisma.exception.groupBy({
				by: ['status'],
				where: whereClause,
				_count: true
			}),

			// Distribution par type
			prisma.exception.groupBy({
				by: ['type'],
				where: whereClause,
				_count: true
			}),

			// Distribution par priorité
			prisma.exception.groupBy({
				by: ['priority'],
				where: whereClause,
				_count: true
			}),

			// Exceptions en attente
			prisma.exception.count({
				where: {
					...whereClause,
					status: 'EN_ATTENTE'
				}
			}),

			// Exceptions assignées à l'utilisateur
			prisma.exception.count({
				where: {
					assignedToId: userId,
					status: { in: ['EN_ATTENTE', 'EN_COURS_TRAITEMENT'] }
				}
			})
		]);

		const stats = {
			total: totalExceptions,
			enAttente: exceptionsEnAttente,
			assignees: exceptionsAssignees,
			distribution: {
				status: distributionParStatut.reduce((acc: Record<string, number>, item: any) => {
					acc[item.status] = item._count;
					return acc;
				}, {} as Record<string, number>),
				type: distributionParType.reduce((acc: Record<string, number>, item: any) => {
					acc[item.type] = item._count;
					return acc;
				}, {} as Record<string, number>),
				priority: distributionParPriorite.reduce((acc: Record<string, number>, item: any) => {
					acc[item.priority] = item._count;
					return acc;
				}, {} as Record<string, number>)
			}
		};

		res.json({
			success: true,
			data: { stats }
		});
	})
);

export default router;
