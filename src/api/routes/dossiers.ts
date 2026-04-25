import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
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
	requireRole,
	requireDossierAccess,
	requireMinimumRole,
	AuthenticatedRequest
} from '../../middleware/auth';
import {
	logDossierEvent,
	logAuditEvent,
	logSystemEvent
} from '../../utils/logger';
import { checkSeuilsLcbFt, checkGelAvoirsDGTresor, checkVigilanceConstante } from '../../services/seuilsLcbFtService';
import TracfinService, { evaluateSuspicion, generateTracfinDeclaration, transmitToErmes, validateDeclaration, getDeclarationHistory } from '../../services/tracfinService';
import { archiveDossier } from '../../services/archivageService';

const router = Router();

const DRAFT_PLACEHOLDER = 'A_COMPLETER';
const DRAFT_PLACEHOLDER_BIRTH_DATE = new Date('1900-01-01T00:00:00.000Z');
const DRAFT_PLACEHOLDER_POSTAL_CODE = '00000';

// Fonction utilitaire pour vérifier pays UE/EEE
function isEUEEACountry(country: string): boolean {
	const eueeaCountries = [
		'Allemagne', 'Autriche', 'Belgique', 'Bulgarie', 'Chypre', 'Croatie', 'Danemark',
		'Espagne', 'Estonie', 'Finlande', 'France', 'Grèce', 'Hongrie', 'Irlande', 'Italie',
		'Lettonie', 'Lituanie', 'Luxembourg', 'Malte', 'Pays-Bas', 'Pologne', 'Portugal',
		'République tchèque', 'Roumanie', 'Slovaquie', 'Slovénie', 'Suède',
		// EEE (non-UE)
		'Islande', 'Liechtenstein', 'Norvège'
	];
	return eueeaCountries.includes(country);
}

function parseIdentityDate(input: string): Date {
	if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
		return new Date(`${input}T00:00:00.000Z`);
	}

	if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) {
		const [day, month, year] = input.split('/').map(Number);
		return new Date(Date.UTC(year, month - 1, day));
	}

	throw new ValidationError('Format de date invalide');
}

function extractValidationObject(validation: unknown): Record<string, any> {
	if (!validation || typeof validation !== 'object' || Array.isArray(validation)) {
		return {};
	}

	return validation as Record<string, any>;
}

const intermediaireSchema = z.object({
	utilise: z.boolean().default(false),
	nom: z.string().optional(),
	prenom: z.string().optional(),
	numeroIdentite: z.string().optional(),
	lienClient: z.string().optional(),
	mandatPresent: z.boolean().default(false),
	mandatType: z.string().optional(),
	mandatDescription: z.string().optional()
});

const moyenPaiementSchema = z.object({
	type: z.enum(['carte', 'especes', 'virement', 'cheque', 'lien_paiement']),
	origineCompte: z.string().optional(),
	paysCompte: z.string().optional(),
	bicSwift: z.string().optional(),
	nombreLiensPaiement: z.number().default(1).optional(),
	raison: z.string().optional()
});

// Validation schemas
const clientSchema = z.object({
	nom: z.string().min(1, 'Nom requis'),
	prenom: z.string().min(1, 'Prénom requis'),
	dateNaissance: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date de naissance invalide (YYYY-MM-DD)'),
	lieuNaissance: z.string().min(1, 'Lieu de naissance requis'),
	nationalite: z.string().min(1, 'Nationalité requise'),
	numeroIdentite: z.string().min(1, 'Numéro d\'identité requis'),
	typeIdentite: z.string().min(1, 'Type d\'identité requis'),
	telephone: z.string().optional(),
	email: z.string().email('Email invalide').optional(),
	adresseComplete: z.string().min(1, 'Adresse complète requise'),
	codePostal: z.string().min(5, 'Code postal invalide'),
	ville: z.string().min(1, 'Ville requise'),
	pays: z.string().default('France'),
	profession: z.string().optional(),
	employeur: z.string().optional(),
	revenus: z.number().positive('Revenus doivent être positifs').optional(),
	patrimoineEstime: z.number().positive('Patrimoine doit être positif').optional(),
	personnePublique: z.boolean().default(false)
});

const createDossierSchema = z.object({
	client: clientSchema,
	typeOuverture: z.string().min(1, 'Type d\'ouverture requis'),
	montantInitial: z.number().positive('Montant initial doit être positif').optional(),
	notes: z.string().optional(),
	// Nouveaux champs pour gestion intermédiaires
	intermediaire: intermediaireSchema.optional(),
	// Nouveau champ pour moyens de paiement
	moyenPaiement: moyenPaiementSchema.optional()
});

const createDraftDossierSchema = z.object({
	typeOuverture: z.string().min(1, 'Type d\'ouverture requis'),
	clientType: z.enum(['physique', 'moral']),
	docType: z.enum(['cni', 'passeport']),
	montantInitial: z.number().positive('Montant initial doit être positif').optional(),
	notes: z.string().optional(),
	seuilLCBFT: z.string().optional(),
	intermediaire: intermediaireSchema.optional(),
	moyenPaiement: moyenPaiementSchema.optional()
});

const updateDossierIdentitySchema = z.object({
	docType: z.enum(['cni', 'passeport']).default('cni'),
	client: z.object({
		nom: z.string().min(1, 'Nom requis'),
		prenom: z.string().min(1, 'Prénom requis'),
		dateNaissance: z.string().refine(
			value => /^\d{2}\/\d{2}\/\d{4}$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value),
			'Date de naissance invalide'
		),
		nationalite: z.string().optional(),
		numeroIdentite: z.string().min(1, 'Numéro d\'identité requis'),
		typeIdentite: z.string().min(1, 'Type d\'identité requis'),
		dateExpiration: z.string().optional(),
		lieuNaissance: z.string().optional(),
		telephone: z.string().optional(),
		email: z.string().email('Email invalide').optional(),
		adresseComplete: z.string().optional(),
		codePostal: z.string().optional(),
		ville: z.string().optional(),
		pays: z.string().optional(),
		profession: z.string().optional(),
		employeur: z.string().optional(),
		revenus: z.number().positive('Revenus doivent être positifs').optional(),
		patrimoineEstime: z.number().positive('Patrimoine doit être positif').optional(),
		personnePublique: z.boolean().optional()
	})
});

const updateDossierSchema = z.object({
	status: z.enum(['BROUILLON', 'EN_COURS', 'ATTENTE_VALIDATION', 'VALIDE', 'REJETE', 'ARCHIVE']).optional(),
	assignedToId: z.string().uuid().optional(),
	typeOuverture: z.string().optional(),
	montantInitial: z.number().positive().optional(),
	dateOuverture: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	notes: z.string().optional()
});

const searchDossiersSchema = z.object({
	page: z.string().regex(/^\d+$/).transform(Number).default(1),
	limit: z.string().regex(/^\d+$/).transform(Number).default(10),
	status: z.string().optional(),
	assignedToId: z.string().uuid().optional(),
	createdById: z.string().uuid().optional(),
	clientName: z.string().optional(),
	dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	sortBy: z.enum(['createdAt', 'updatedAt', 'numero', 'status']).default('createdAt'),
	sortOrder: z.enum(['asc', 'desc']).default('desc')
});

// Génération du numéro de dossier séquentiel
async function generateDossierNumber(): Promise<string> {
	const year = new Date().getFullYear();
	const prefix = `DOS-${year}-`;

	const lastDossier = await prisma.dossier.findFirst({
		where: {
			numero: {
				startsWith: prefix
			}
		},
		orderBy: { numero: 'desc' }
	});

	let nextNumber = 1;
	if (lastDossier) {
		const lastNumber = parseInt(lastDossier.numero.split('-')[2]);
		nextNumber = lastNumber + 1;
	}

	return `${prefix}${nextNumber.toString().padStart(6, '0')}`;
}

// POST /api/dossiers - Créer un nouveau dossier
router.post('/',
	authenticateToken,
	requireRole('CONSEILLER', 'CAISSE', 'REFERENT', 'RESPONSABLE', 'ADMIN'),
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const validatedData = createDossierSchema.parse(req.body);
		const userId = req.user!.id;

		// Vérification des seuils LCB-FT selon règles GODECHOT PAULIET
		const seuilCheck = await checkSeuilsLcbFt(
			validatedData.client.numeroIdentite,
			validatedData.montantInitial || 0,
			userId
		);

		// Vérification gel des avoirs DG Trésor pour tous les clients
		const gelAvoirsCheck = await checkGelAvoirsDGTresor(
			`${validatedData.client.prenom} ${validatedData.client.nom}`,
			userId
		);

		// Validation intermédiaire si utilisé
		if (validatedData.intermediaire?.utilise) {
			if (!validatedData.intermediaire.nom || !validatedData.intermediaire.numeroIdentite) {
				throw new ValidationError('Nom et pièce d\'identité de l\'intermédiaire requis');
			}
			if (!validatedData.intermediaire.mandatPresent) {
				throw new ValidationError('Mandat de l\'intermédiaire requis (email, WhatsApp ou attestation)');
			}
		}

		// Validation moyen de paiement selon règles LCB-FT
		if (validatedData.moyenPaiement) {
			const mp = validatedData.moyenPaiement;

			// Limite 3 liens de paiement selon procédures GODECHOT PAULIET
			if (mp.type === 'lien_paiement' && (mp.nombreLiensPaiement || 1) > 3) {
				throw new ValidationError('Maximum 3 liens de paiement autorisés par transaction');
			}

			// Vérification origine compte UE/EEE pour virements
			if (mp.type === 'virement' && mp.paysCompte && !isEUEEACountry(mp.paysCompte)) {
				throw new ValidationError('Virement autorisé uniquement depuis pays UE/EEE selon procédures LCB-FT');
			}
		}

		// Blocage immédiat si match gel des avoirs
		if (gelAvoirsCheck.isListed) {
			throw new AppError('Transaction bloquée — correspondance détectée sur le registre gel des avoirs DG Trésor', 403, 'BLOCAGE_GEL_AVOIRS');
		}

		// Vérification de l'unicité du numéro d'identité
		const existingClient = await prisma.client.findUnique({
			where: { numeroIdentite: validatedData.client.numeroIdentite }
		});

		let clientId: string;

		if (existingClient) {
			// Mise à jour des informations du client existant
			const updatedClient = await prisma.client.update({
				where: { id: existingClient.id },
				data: {
					...validatedData.client,
					dateNaissance: new Date(validatedData.client.dateNaissance),
					updatedAt: new Date()
				}
			});
			clientId = updatedClient.id;

			logDossierEvent({
				action: 'client_updated',
				dossierId: '',
				userId,
				details: {
					clientId: clientId,
					numeroIdentite: validatedData.client.numeroIdentite
				}
			});
		} else {
			// Création d'un nouveau client
			const newClient = await prisma.client.create({
				data: {
					...validatedData.client,
					dateNaissance: new Date(validatedData.client.dateNaissance)
				}
			});
			clientId = newClient.id;

			logDossierEvent({
				action: 'client_created',
				dossierId: '',
				userId,
				details: {
					clientId: clientId,
					numeroIdentite: validatedData.client.numeroIdentite
				}
			});
		}

		// Génération du numéro de dossier
		const numeroDossier = await generateDossierNumber();

		// Création du dossier avec métadonnées LCB-FT
		const dossier = await prisma.dossier.create({
			data: {
				numero: numeroDossier,
				clientId,
				createdById: userId,
				typeOuverture: validatedData.typeOuverture,
				montantInitial: validatedData.montantInitial,
				notes: validatedData.notes,
				status: 'BROUILLON',
				// Stockage métadonnées LCB-FT
				validation: {
					seuilCheck: seuilCheck as any,
					gelAvoirsCheck: gelAvoirsCheck as any,
					intermediaire: validatedData.intermediaire ?? null,
					moyenPaiement: validatedData.moyenPaiement ?? null,
					timestamp: new Date()
				} as any
			},
			include: {
				client: true,
				createdBy: {
					select: { id: true, firstName: true, lastName: true, role: true }
				}
			}
		});

		logDossierEvent({
			action: 'dossier_created',
			dossierId: dossier.id,
			userId,
			details: {
				numeroDossier: dossier.numero,
				typeOuverture: dossier.typeOuverture,
				clientId
			}
		});

		logAuditEvent({
			userId,
			action: 'CREATE',
			resource: 'dossier',
			resourceId: dossier.id,
			newValues: dossier,
			ipAddress: req.ip
		});

		res.status(201).json({
			success: true,
			data: { dossier }
		});
	})
);

// POST /api/dossiers/drafts - Créer un brouillon persistant avant OCR
router.post('/drafts',
	authenticateToken,
	requireRole('CONSEILLER', 'CAISSE', 'REFERENT', 'RESPONSABLE', 'ADMIN'),
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const validatedData = createDraftDossierSchema.parse(req.body);
		const userId = req.user!.id;
		const numeroDossier = await generateDossierNumber();
		const draftIdentityNumber = `DRAFT-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

		const client = await prisma.client.create({
			data: {
				nom: DRAFT_PLACEHOLDER,
				prenom: DRAFT_PLACEHOLDER,
				dateNaissance: DRAFT_PLACEHOLDER_BIRTH_DATE,
				lieuNaissance: DRAFT_PLACEHOLDER,
				nationalite: DRAFT_PLACEHOLDER,
				numeroIdentite: draftIdentityNumber,
				typeIdentite: validatedData.docType.toUpperCase(),
				adresseComplete: DRAFT_PLACEHOLDER,
				codePostal: DRAFT_PLACEHOLDER_POSTAL_CODE,
				ville: DRAFT_PLACEHOLDER,
				pays: 'France'
			}
		});

		const dossier = await prisma.dossier.create({
			data: {
				numero: numeroDossier,
				clientId: client.id,
				createdById: userId,
				typeOuverture: validatedData.typeOuverture,
				montantInitial: validatedData.montantInitial,
				notes: validatedData.notes,
				status: 'BROUILLON',
				validation: {
					draft: true,
					draftCreatedAt: new Date(),
					clientType: validatedData.clientType,
					docType: validatedData.docType,
					seuilLCBFT: validatedData.seuilLCBFT ?? null,
					intermediaire: validatedData.intermediaire ?? null,
					moyenPaiement: validatedData.moyenPaiement ?? null
				} as any
			},
			include: {
				client: true,
				createdBy: {
					select: { id: true, firstName: true, lastName: true, role: true }
				}
			}
		});

		logDossierEvent({
			action: 'dossier_created',
			dossierId: dossier.id,
			userId,
			details: {
				numeroDossier: dossier.numero,
				typeOuverture: dossier.typeOuverture,
				clientType: validatedData.clientType,
				docType: validatedData.docType
			}
		});

		logAuditEvent({
			userId,
			action: 'CREATE',
			resource: 'dossier_draft',
			resourceId: dossier.id,
			newValues: dossier,
			ipAddress: req.ip
		});

		res.status(201).json({
			success: true,
			data: { dossier }
		});
	})
);

// GET /api/dossiers - Liste paginée des dossiers
router.get('/',
	authenticateToken,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const params = searchDossiersSchema.parse(req.query);
		const userId = req.user!.id;
		const userRole = req.user!.role;

		// Construction des filtres basés sur les permissions
		let whereClause: any = {};

		// Filtrage par rôle
		if (userRole === 'CAISSE') {
			// La caisse ne voit strictement que les dossiers qu'elle a créés
			whereClause.createdById = userId;
		} else if (userRole === 'CONSEILLER') {
			// Le conseiller voit ses propres dossiers ou ceux qui lui sont assignés
			whereClause.OR = [
				{ createdById: userId },
				{ assignedToId: userId }
			];
		}
		// REFERENT, RESPONSABLE et ADMIN peuvent voir tous les dossiers

		// Les brouillons ne sont jamais affichés dans la liste
		whereClause.status = { not: 'BROUILLON' };

		// Filtres additionnels (ignorés pour CAISSE — ils ne peuvent pas sortir de leur périmètre)
		if (params.status) {
			whereClause.status = params.status !== 'BROUILLON' ? params.status : { not: 'BROUILLON' };
		}

		if (params.assignedToId && userRole !== 'CAISSE') {
			whereClause.assignedToId = params.assignedToId;
		}

		if (params.createdById && userRole !== 'CAISSE') {
			whereClause.createdById = params.createdById;
		}

		if (params.clientName) {
			whereClause.client = {
				OR: [
					{ nom: { contains: params.clientName, mode: 'insensitive' } },
					{ prenom: { contains: params.clientName, mode: 'insensitive' } }
				]
			};
		}

		if (params.dateFrom || params.dateTo) {
			whereClause.createdAt = {};
			if (params.dateFrom) {
				whereClause.createdAt.gte = new Date(params.dateFrom);
			}
			if (params.dateTo) {
				whereClause.createdAt.lte = new Date(params.dateTo + 'T23:59:59.999Z');
			}
		}

		// Calcul de la pagination
		const skip = (params.page - 1) * params.limit;

		// Requête avec pagination
		const [dossiers, total] = await Promise.all([
			prisma.dossier.findMany({
				where: whereClause,
				include: {
					client: {
						select: {
							id: true,
							nom: true,
							prenom: true,
							dateNaissance: true,
							numeroIdentite: true
						}
					},
					createdBy: {
						select: { id: true, firstName: true, lastName: true }
					},
					assignedTo: {
						select: { id: true, firstName: true, lastName: true }
					},
					_count: {
						select: {
							documents: true,
							recherches: true,
							exceptions: true
						}
					}
				},
				orderBy: { [params.sortBy]: params.sortOrder },
				skip,
				take: params.limit
			}),
			prisma.dossier.count({ where: whereClause })
		]);

		const totalPages = Math.ceil(total / params.limit);

		res.json({
			success: true,
			data: {
				dossiers,
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

// GET /api/dossiers/:dossierId - Détails d'un dossier
router.get('/:dossierId',
	authenticateToken,
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;

		const dossier = await prisma.dossier.findUnique({
			where: { id: dossierId },
			include: {
				client: true,
				createdBy: {
					select: { id: true, firstName: true, lastName: true, role: true }
				},
				assignedTo: {
					select: { id: true, firstName: true, lastName: true, role: true }
				},
				validatedBy: {
					select: { id: true, firstName: true, lastName: true, role: true }
				},
				documents: {
					select: {
						id: true,
						fileName: true,
						originalName: true,
						type: true,
						fileSize: true,
						isVerified: true,
						createdAt: true
					}
				},
				recherches: {
					select: {
						id: true,
						type: true,
						status: true,
						confidence: true,
						executedAt: true,
						completedAt: true
					}
				},
				exceptions: {
					where: { status: { not: 'RESOLUE' } },
					select: {
						id: true,
						type: true,
						description: true,
						priority: true,
						status: true,
						createdAt: true
					}
				}
			}
		});

		if (!dossier) {
			throw new ValidationError('Dossier non trouvé');
		}

		logAuditEvent({
			userId: req.user!.id,
			action: 'READ',
			resource: 'dossier',
			resourceId: dossierId,
			ipAddress: req.ip
		});

		res.json({
			success: true,
			data: { dossier }
		});
	})
);

// PATCH /api/dossiers/:dossierId/identity - Hydrater un brouillon avec l'identité réelle
router.patch('/:dossierId/identity',
	authenticateToken,
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;
		const validatedData = updateDossierIdentitySchema.parse(req.body);
		const userId = req.user!.id;

		const currentDossier = await prisma.dossier.findUnique({
			where: { id: dossierId },
			include: { client: true }
		});

		if (!currentDossier) {
			throw new ValidationError('Dossier non trouvé');
		}

		const currentValidation = extractValidationObject(currentDossier.validation);
		const clientInput = validatedData.client;
		const normalizedBirthDate = parseIdentityDate(clientInput.dateNaissance);
		const numeroIdentite = clientInput.numeroIdentite.trim();
		const existingClient = await prisma.client.findUnique({
			where: { numeroIdentite }
		});
		const clientBase = existingClient && existingClient.id !== currentDossier.clientId
			? existingClient
			: currentDossier.client;

		const clientPayload = {
			nom: clientInput.nom.trim(),
			prenom: clientInput.prenom.trim(),
			dateNaissance: normalizedBirthDate,
			lieuNaissance: clientInput.lieuNaissance?.trim() || clientBase.lieuNaissance || DRAFT_PLACEHOLDER,
			nationalite: clientInput.nationalite?.trim() || clientBase.nationalite || DRAFT_PLACEHOLDER,
			numeroIdentite,
			typeIdentite: clientInput.typeIdentite.trim(),
			telephone: clientInput.telephone?.trim() || clientBase.telephone || undefined,
			email: clientInput.email?.trim() || clientBase.email || undefined,
			adresseComplete: clientInput.adresseComplete?.trim() || clientBase.adresseComplete || DRAFT_PLACEHOLDER,
			codePostal: clientInput.codePostal?.trim() || clientBase.codePostal || DRAFT_PLACEHOLDER_POSTAL_CODE,
			ville: clientInput.ville?.trim() || clientBase.ville || DRAFT_PLACEHOLDER,
			pays: clientInput.pays?.trim() || clientBase.pays || 'France',
			profession: clientInput.profession?.trim() || clientBase.profession || undefined,
			employeur: clientInput.employeur?.trim() || clientBase.employeur || undefined,
			revenus: clientInput.revenus ?? clientBase.revenus ?? undefined,
			patrimoineEstime: clientInput.patrimoineEstime ?? clientBase.patrimoineEstime ?? undefined,
			personnePublique: clientInput.personnePublique ?? clientBase.personnePublique
		};

		let targetClientId = currentDossier.clientId;
		let updatedClient = currentDossier.client;

		if (existingClient && existingClient.id !== currentDossier.clientId) {
			updatedClient = await prisma.client.update({
				where: { id: existingClient.id },
				data: clientPayload
			});
			targetClientId = existingClient.id;
		} else {
			updatedClient = await prisma.client.update({
				where: { id: currentDossier.clientId },
				data: clientPayload
			});
		}

		const updatedDossier = await prisma.dossier.update({
			where: { id: dossierId },
			data: {
				clientId: targetClientId,
				status: currentDossier.status === 'BROUILLON' ? 'EN_COURS' : currentDossier.status,
				validation: {
					...currentValidation,
					draft: false,
					identity: {
						docType: validatedData.docType,
						dateExpiration: clientInput.dateExpiration ?? null,
						completedAt: new Date()
					}
				} as any
			},
			include: {
				client: true,
				createdBy: {
					select: { id: true, firstName: true, lastName: true, role: true }
				}
			}
		});

		if (
			targetClientId !== currentDossier.clientId &&
			currentDossier.client.numeroIdentite.startsWith('DRAFT-')
		) {
			const draftClientDossiers = await prisma.dossier.count({
				where: { clientId: currentDossier.clientId }
			});

			if (draftClientDossiers === 0) {
				await prisma.client.delete({
					where: { id: currentDossier.clientId }
				});
			}
		}

		logDossierEvent({
			action: 'dossier_updated',
			dossierId,
			userId,
			details: {
				clientId: updatedClient.id,
				numeroIdentite: updatedClient.numeroIdentite,
				docType: validatedData.docType
			}
		});

		logAuditEvent({
			userId,
			action: 'UPDATE',
			resource: 'dossier_identity',
			resourceId: dossierId,
			oldValues: currentDossier,
			newValues: updatedDossier,
			ipAddress: req.ip
		});

		res.json({
			success: true,
			data: { dossier: updatedDossier }
		});
	})
);

// PATCH /api/dossiers/:dossierId - Mise à jour d'un dossier
router.patch('/:dossierId',
	authenticateToken,
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;
		const validatedData = updateDossierSchema.parse(req.body);
		const userId = req.user!.id;

		// Récupération du dossier actuel pour audit
		const currentDossier = await prisma.dossier.findUnique({
			where: { id: dossierId }
		});

		if (!currentDossier) {
			throw new ValidationError('Dossier non trouvé');
		}

		// Vérifications métier
		if (validatedData.status) {
			// Transition idempotente : même statut → pas d'erreur, pas de mise à jour
			if (currentDossier.status === validatedData.status) {
				return res.json({ success: true, data: currentDossier });
			}

			// Vérification des transitions de statut autorisées
			const allowedTransitions: Record<string, string[]> = {
				'BROUILLON': ['EN_COURS', 'ARCHIVE'],
				'EN_COURS': ['ATTENTE_VALIDATION', 'VALIDE', 'REJETE', 'BROUILLON', 'ARCHIVE'],
				'ATTENTE_VALIDATION': ['VALIDE', 'REJETE', 'EN_COURS'],
				'VALIDE': ['ARCHIVE'],
				'REJETE': ['EN_COURS', 'ARCHIVE'],
				'ARCHIVE': [],
			};

			if (!allowedTransitions[currentDossier.status]?.includes(validatedData.status)) {
				throw new ValidationError(
					`Transition de statut non autorisée: ${currentDossier.status} -> ${validatedData.status}`
				);
			}

			// VALIDE/REJETE : REFERENT+, ou le créateur du dossier (CAISSE qui a ouvert le dossier)
			if (['VALIDE', 'REJETE'].includes(validatedData.status) &&
				!['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(req.user!.role) &&
				currentDossier.createdById !== userId) {
				throw new AuthorizationError('Privilèges insuffisants pour valider/rejeter un dossier');
			}
		}

		// Préparation des données de mise à jour
		const updateData: any = { ...validatedData };

		if (validatedData.dateOuverture) {
			updateData.dateOuverture = new Date(validatedData.dateOuverture);
		}

		if (validatedData.status === 'VALIDE') {
			updateData.validatedById = userId;
		}

		// Mise à jour du dossier
		const updatedDossier = await prisma.dossier.update({
			where: { id: dossierId },
			data: updateData,
			include: {
				client: true,
				createdBy: { select: { id: true, firstName: true, lastName: true } },
				assignedTo: { select: { id: true, firstName: true, lastName: true } },
				validatedBy: { select: { id: true, firstName: true, lastName: true } }
			}
		});

		logDossierEvent({
			action: 'dossier_updated',
			dossierId,
			userId,
			details: {
				changes: validatedData,
				previousStatus: currentDossier.status,
				newStatus: updatedDossier.status
			}
		});

		logAuditEvent({
			userId,
			action: 'UPDATE',
			resource: 'dossier',
			resourceId: dossierId,
			oldValues: currentDossier,
			newValues: updatedDossier,
			ipAddress: req.ip
		});

		// Archivage LCB-FT automatique sur toute transition vers VALIDE, REJETE ou ARCHIVE
		const STATUTS_ARCHIVAGE = ['VALIDE', 'REJETE', 'ARCHIVE'];
		if (
			validatedData.status &&
			STATUTS_ARCHIVAGE.includes(validatedData.status) &&
			!STATUTS_ARCHIVAGE.includes(currentDossier.status)
		) {
			archiveDossier(dossierId, userId, validatedData.status).catch((err: unknown) => {
				logSystemEvent({
					action: 'security_alert',
					component: 'archivage_auto',
					details: {
						dossierId,
						triggerStatus: validatedData.status,
						error: String(err)
					},
					severity: 'error'
				});
			});
		}

		res.json({
			success: true,
			data: { dossier: updatedDossier }
		});
	})
);

// GET /api/dossiers/:dossierId/timeline - Historique des événements
router.get('/:dossierId/timeline',
	authenticateToken,
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;

		const auditLogs = await prisma.auditLog.findMany({
			where: { dossierId },
			include: {
				user: {
					select: { firstName: true, lastName: true, role: true }
				}
			},
			orderBy: { timestamp: 'desc' },
			take: 100 // Limiter à 100 événements récents
		});

		res.json({
			success: true,
			data: { timeline: auditLogs }
		});
	})
);

// POST /api/dossiers/:dossierId/assign - Assigner un dossier
router.post('/:dossierId/assign',
	authenticateToken,
	requireMinimumRole('REFERENT'),
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;
		const { assignToUserId } = z.object({
			assignToUserId: z.string().uuid('ID utilisateur invalide')
		}).parse(req.body);

		// Vérification que l'utilisateur cible existe et est actif
		const targetUser = await prisma.user.findUnique({
			where: { id: assignToUserId },
			select: { id: true, firstName: true, lastName: true, isActive: true, role: true }
		});

		if (!targetUser || !targetUser.isActive) {
			throw new ValidationError('Utilisateur invalide ou inactif');
		}

		const updatedDossier = await prisma.dossier.update({
			where: { id: dossierId },
			data: { assignedToId: assignToUserId },
			include: {
				assignedTo: { select: { id: true, firstName: true, lastName: true, role: true } }
			}
		});

		logDossierEvent({
			action: 'dossier_assigned',
			dossierId,
			userId: req.user!.id,
			details: {
				assignedToUserId: assignToUserId,
				assignedToName: `${targetUser.firstName} ${targetUser.lastName}`
			}
		});

		res.json({
			success: true,
			data: { dossier: updatedDossier },
			message: `Dossier assigné à ${targetUser.firstName} ${targetUser.lastName}`
		});
	})
);

// GET /api/dossiers/:dossierId/vigilance-constante - Vérifier vigilance constante
router.get('/:dossierId/vigilance-constante',
	authenticateToken,
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;

		const dossier = await prisma.dossier.findUnique({
			where: { id: dossierId },
			include: { client: true }
		});

		if (!dossier) {
			throw new AppError('Dossier non trouvé', 404, 'DOSSIER_NOT_FOUND');
		}

		const vigilanceCheck = await checkVigilanceConstante(
			dossier.clientId,
			req.user!.id
		);

		res.json({
			success: true,
			data: { vigilanceCheck }
		});
	})
);

// POST /api/dossiers/check-gel-avoirs - Vérifier gel des avoirs pour un nom
router.post('/check-gel-avoirs',
	authenticateToken,
	requireRole('CONSEILLER', 'CAISSE', 'REFERENT', 'RESPONSABLE', 'ADMIN'),
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { nom, prenom } = z.object({
			nom: z.string().min(1, 'Nom requis'),
			prenom: z.string().min(1, 'Prénom requis')
		}).parse(req.body);

		const gelCheck = await checkGelAvoirsDGTresor(
			`${prenom} ${nom}`,
			req.user!.id
		);

		res.json({
			success: true,
			data: { gelCheck }
		});
	})
);

// GET /api/dossiers/:dossierId/seuils-check - Vérifier seuils LCB-FT
router.get('/:dossierId/seuils-check',
	authenticateToken,
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;

		const dossier = await prisma.dossier.findUnique({
			where: { id: dossierId },
			include: { client: true }
		});

		if (!dossier) {
			throw new AppError('Dossier non trouvé', 404, 'DOSSIER_NOT_FOUND');
		}

		const seuilCheck = await checkSeuilsLcbFt(
			dossier.client.numeroIdentite,
			dossier.montantInitial || 0,
			req.user!.id
		);

		res.json({
			success: true,
			data: { seuilCheck }
		});
	})
);

// ═══════════════════════════════════════════════════════════════════════════════
// Routes TRACFIN - Déclarations de Soupçon Opérationnel
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/dossiers/:id/evaluate-suspicion - Évaluer le niveau de suspicion
router.post('/:id/evaluate-suspicion',
	authenticateToken,
	requireRole('CONSEILLER', 'CAISSE', 'REFERENT', 'RESPONSABLE', 'ADMIN'),
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { id: dossierId } = req.params;
		const userId = req.user!.id;

		// Schema de validation pour l'évaluation de suspicion
		const evaluationSchema = z.object({
			montant: z.number().positive('Montant doit être positif'),
			moyenPaiement: z.string().min(1, 'Moyen de paiement requis'),
			origineGeographique: z.string().optional(),
			clientBehavior: z.enum(['normal', 'evasive', 'suspicious']).optional(),
			hasIdentityIssues: z.boolean().default(false),
			additionalInfo: z.string().optional()
		});

		const validatedData = evaluationSchema.parse(req.body);

		// Récupération du dossier avec client
		const dossier = await prisma.dossier.findUnique({
			where: { id: dossierId },
			include: {
				client: true,
				createdBy: { select: { id: true, firstName: true, lastName: true } }
			}
		});

		if (!dossier) {
			throw new AppError('Dossier non trouvé', 404, 'NOT_FOUND');
		}

		// Vérification des permissions
		if (req.user!.role === 'CONSEILLER' && dossier.createdById !== userId) {
			throw new AuthorizationError('Accès non autorisé à ce dossier');
		}

		// Récupération de l'historique transactionnel pour calcul fréquence
		const recentTransactions = await prisma.dossier.count({
			where: {
				clientId: dossier.clientId,
				createdAt: {
					gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 jours
				}
			}
		});

		// Détermination du type de client selon procédures GODECHOT PAULIET
		const seuilCheck = await checkSeuilsLcbFt(
			dossier.client.numeroIdentite,
			validatedData.montant,
			userId
		);

		// Vérification gel des avoirs DG Trésor
		const gelAvoirsCheck = await checkGelAvoirsDGTresor(
			`${dossier.client.prenom} ${dossier.client.nom}`,
			userId
		);

		// Simulation vérifications sanctions/PPE (à intégrer avec identityVerificationService)
		const isPEP = dossier.client.personnePublique || false;
		const hasSanctions = false; // À implémenter avec verifyIdentityLCBFT

		// Évaluation du niveau de suspicion
		const evaluation = evaluateSuspicion({
			montant: validatedData.montant,
			clientType: seuilCheck.clientType,
			moyenPaiement: validatedData.moyenPaiement,
			origineGeographique: validatedData.origineGeographique,
			hasIdentityIssues: validatedData.hasIdentityIssues,
			isPEP,
			hasSanctions,
			hasGelAvoirs: gelAvoirsCheck.isListed || false,
			clientBehavior: validatedData.clientBehavior,
			transactionFrequency: recentTransactions
		});

		// Logging de l'évaluation
		logDossierEvent({
			action: 'suspicion_evaluated',
			dossierId,
			userId,
			details: {
				score: evaluation.score,
				risque: evaluation.risque,
				criteres: evaluation.criteres.map(c => c.code),
				recommendDSO: evaluation.recommendDSO
			}
		});

		res.json({
			success: true,
			data: {
				evaluation,
				dossierInfo: {
					numero: dossier.numero,
					client: {
						nom: dossier.client.nom,
						prenom: dossier.client.prenom
					}
				},
				verificationsLCBFT: {
					seuilCheck,
					gelAvoirsCheck
				}
			}
		});
	})
);

// POST /api/dossiers/:id/generate-tracfin-declaration - Générer déclaration TRACFIN
router.post('/:id/generate-tracfin-declaration',
	authenticateToken,
	requireRole('REFERENT', 'RESPONSABLE', 'ADMIN'), // Seuls les rôles élevés peuvent générer des DSO
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { id: dossierId } = req.params;
		const userId = req.user!.id;

		// Schema pour génération déclaration
		const declarationSchema = z.object({
			evaluationResult: z.object({
				score: z.number(),
				criteres: z.array(z.object({
					code: z.string(),
					libelle: z.string(),
					poids: z.number(),
					description: z.string(),
					domaine: z.string()
				})),
				risque: z.enum(['FAIBLE', 'MODÉRÉ', 'ÉLEVÉ', 'TRÈS_ÉLEVÉ']),
				recommendDSO: z.boolean()
			}),
			operationInfo: z.object({
				montant: z.number().positive(),
				devise: z.string().default('EUR'),
				moyenPaiement: z.string(),
				origineGeographique: z.string().optional(),
				beneficiaire: z.string().optional()
			})
		});

		const validatedData = declarationSchema.parse(req.body);

		// Récupération du dossier avec client
		const dossier = await prisma.dossier.findUnique({
			where: { id: dossierId },
			include: {
				client: true
			}
		});

		if (!dossier) {
			throw new AppError('Dossier non trouvé', 404, 'NOT_FOUND');
		}

		// Vérification que le score justifie une DSO
		if (!validatedData.evaluationResult.recommendDSO) {
			throw new ValidationError('Le niveau de suspicion ne justifie pas une déclaration TRACFIN');
		}

		// Génération de la déclaration
		const declaration = generateTracfinDeclaration({
			dossierId,
			clientInfo: {
				nom: dossier.client.nom,
				prenom: dossier.client.prenom,
				dateNaissance: dossier.client.dateNaissance.toISOString().split('T')[0].split('-').reverse().join('/'), // DD/MM/YYYY
				nationalite: dossier.client.nationalite,
				adresse: dossier.client.adresseComplete
			},
			operationInfo: {
				...validatedData.operationInfo,
				dateOperation: new Date()
			},
			evaluationResult: validatedData.evaluationResult as any,
			createdBy: userId
		});

		// Sauvegarde en base (à implémenter selon schéma Prisma)
		// await prisma.tracfinDeclaration.create({ data: declaration });

		logDossierEvent({
			action: 'tracfin_declaration_generated',
			dossierId,
			userId,
			details: {
				declarationId: declaration.id,
				score: declaration.evaluationSoupcon.score,
				risque: declaration.evaluationSoupcon.risqueIdentifie
			}
		});

		logAuditEvent({
			userId,
			action: 'CREATE',
			resource: 'tracfin_declaration',
			resourceId: declaration.id,
			newValues: declaration,
			ipAddress: req.ip
		});

		res.status(201).json({
			success: true,
			data: { declaration }
		});
	})
);

// POST /api/dossiers/tracfin-declarations/:declarationId/transmit - Transmettre à Ermès
router.post('/tracfin-declarations/:declarationId/transmit',
	authenticateToken,
	requireRole('RESPONSABLE', 'ADMIN'), // Seuls les responsables peuvent transmettre
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { declarationId } = req.params;
		const userId = req.user!.id;

		// En production, récupérer la déclaration depuis la BDD
		// const declaration = await prisma.tracfinDeclaration.findUnique({ where: { id: declarationId } });

		// Pour l'instant, simulation avec données de test
		const declaration = {
			id: declarationId,
			dossierId: 'test-dossier',
			evaluationSoupcon: { score: 45 }
		} as any;

		if (!declaration) {
			throw new AppError('Déclaration TRACFIN non trouvée', 404, 'NOT_FOUND');
		}

		// Validation avant transmission
		const validation = validateDeclaration(declaration);
		if (!validation.isValid) {
			throw new ValidationError(`Déclaration invalide: ${validation.errors.join(', ')}`);
		}

		// Transmission à Ermès
		const transmissionResult = await transmitToErmes(declaration);

		if (!transmissionResult.success) {
			throw new AppError(`Échec transmission Ermès: ${transmissionResult.error}`, 500, 'TRANSMISSION_FAILED');
		}

		// Mise à jour du statut en base
		// await prisma.tracfinDeclaration.update({
		//   where: { id: declarationId },
		//   data: {
		//     status: 'TRANSMISE',
		//     ermesReference: transmissionResult.ermesReference
		//   }
		// });

		logDossierEvent({
			action: 'tracfin_declaration_transmitted',
			dossierId: declaration.dossierId,
			userId,
			details: {
				declarationId,
				ermesReference: transmissionResult.ermesReference,
				transmissionDate: new Date()
			}
		});

		res.json({
			success: true,
			data: {
				ermesReference: transmissionResult.ermesReference,
				transmissionDate: new Date(),
				status: 'TRANSMISE'
			}
		});
	})
);

// GET /api/dossiers/:id/tracfin-history - Historique des déclarations TRACFIN du client
router.get('/:id/tracfin-history',
	authenticateToken,
	requireRole('REFERENT', 'RESPONSABLE', 'ADMIN'),
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { id: dossierId } = req.params;

		// Récupération du dossier avec informations client
		const dossier = await prisma.dossier.findUnique({
			where: { id: dossierId },
			include: {
				client: true
			}
		});

		if (!dossier) {
			throw new AppError('Dossier non trouvé', 404, 'NOT_FOUND');
		}

		// Récupération historique TRACFIN
		const history = await getDeclarationHistory({
			nom: dossier.client.nom,
			prenom: dossier.client.prenom,
			dateNaissance: dossier.client.dateNaissance.toISOString().split('T')[0].split('-').reverse().join('/')
		});

		logDossierEvent({
			action: 'tracfin_history_accessed',
			dossierId,
			userId: req.user!.id,
			details: {
				clientId: dossier.clientId,
				historyCount: history.length
			}
		});

		res.json({
			success: true,
			data: {
				clientInfo: {
					nom: dossier.client.nom,
					prenom: dossier.client.prenom
				},
				history
			}
		});
	})
);

export default router;
