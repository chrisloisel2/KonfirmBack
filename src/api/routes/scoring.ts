import { Router, Response } from 'express';
import prisma from '../../lib/prisma';
import { z } from 'zod';
import {
	AppError,
	ValidationError,
	asyncHandler
} from '../../middleware/errorHandler';
import {
	authenticateToken,
	requireDossierAccess,
	AuthenticatedRequest
} from '../../middleware/auth';
import {
	logScoringEvent,
	logAuditEvent
} from '../../utils/logger';
import { checkCompanyIntelligence } from '../../services/companyIntelligenceService';

const router = Router();

// Configuration du scoring (depuis variables d'environnement)
const SCORING_CONFIG = {
	weights: {
		ppe: parseFloat(process.env.SCORING_PPE_WEIGHT || '40') / 100,
		sanctions: parseFloat(process.env.SCORING_SANCTIONS_WEIGHT || '40') / 100,
		assetFreeze: parseFloat(process.env.SCORING_ASSET_FREEZE_WEIGHT || '20') / 100
	},
	thresholds: {
		low: parseFloat(process.env.SCORING_THRESHOLD_LOW || '30'),
		medium: parseFloat(process.env.SCORING_THRESHOLD_MEDIUM || '60'),
		high: parseFloat(process.env.SCORING_THRESHOLD_HIGH || '85')
	},
	factors: {
		// Facteurs de risque basés sur les données client
		profession: {
			'politique': 50,
			'diplomate': 40,
			'dirigeant': 30,
			'militaire': 25,
			'magistrat': 20,
			'avocat': 10,
			'default': 0
		},
		nationality: {
			// Pays à risque élevé selon GAFI
			'north_korea': 100,
			'iran': 90,
			'syria': 80,
			'afghanistan': 70,
			'default': 0
		},
		revenue: {
			// Revenus élevés nécessitent plus de vérifications
			'above_500k': 20,
			'above_100k': 10,
			'above_50k': 5,
			'default': 0
		},
		age: {
			'minor': 30,
			'senior': 10,
			'default': 0
		},
		payment: {
			'especes': 60,      // Espèces = risque LCB-FT élevé
			'cheque': 20,
			'lien_paiement': 30,
			'virement': 5,      // Virement UE/EEE normal
			'virement_hors_ue': 40,
			'carte': 5,
			'default': 0
		},
		amount: {
			'above_50k': 40,
			'above_20k': 30,
			'above_10k': 20,
			'above_5k': 10,
			'default': 0
		}
	}
};

const EU_EEA_COUNTRIES = new Set([
	'france', 'allemagne', 'espagne', 'italie', 'portugal', 'belgique',
	'pays-bas', 'luxembourg', 'autriche', 'suisse', 'suède', 'norvège',
	'danemark', 'finlande', 'irlande', 'grèce', 'pologne', 'tcheque',
	'hongrie', 'roumanie', 'bulgarie', 'slovaquie', 'slovénie', 'croatie',
	'estonie', 'lettonie', 'lituanie', 'malte', 'chypre', 'islande',
	'liechtenstein', 'germany', 'spain', 'italy', 'netherlands', 'sweden',
	'norway', 'denmark', 'finland', 'ireland', 'greece', 'poland', 'austria'
]);

// Validation schemas
const scoringRequestSchema = z.object({
	forceRecalculation: z.boolean().default(false)
});

// Interface pour les facteurs de risque
interface RiskFactor {
	name: string;
	value: number;
	weight: number;
	score: number;
	description: string;
	source: string;
}

// Interface pour le scoring complet
interface ScoringResult {
	scoreTotal: number;
	niveau: 'FAIBLE' | 'MOYEN' | 'ELEVE' | 'CRITIQUE';
	recommandation: 'ACCEPTER' | 'REFUSER' | 'VALIDER_MANUELLEMENT';
	justification: string;
	facteurs: RiskFactor[];
	seuilDecision: number;
}

// Fonction principale de calcul du scoring
async function calculateRiskScore(dossierId: string): Promise<ScoringResult> {
	// Récupération de toutes les données nécessaires
	const dossier = await prisma.dossier.findUnique({
		where: { id: dossierId },
		include: {
			client: true,
			recherches: {
				where: { status: 'TERMINE' }
			},
			documents: {
				where: { isVerified: true }
			},
			exceptions: {
				where: {
					status: { in: ['EN_ATTENTE', 'EN_COURS_TRAITEMENT'] }
				}
			}
		}
	});

	if (!dossier) {
		throw new ValidationError('Dossier non trouvé');
	}

	const factors: RiskFactor[] = [];
	let totalScore = 0;

	// 1. Facteurs basés sur les recherches LCB-FT
	const ppeSearches = dossier.recherches.filter((r: any) => r.type === 'PPE');
	const sanctionsSearches = dossier.recherches.filter((r: any) => r.type === 'SANCTIONS');
	const assetFreezeSearches = dossier.recherches.filter((r: any) => r.type === 'ASSET_FREEZE');

	// Score PPE
	let ppeScore = 0;
	for (const search of ppeSearches) {
		if (search.matches && Array.isArray(search.matches) && search.matches.length > 0) {
			const maxConfidence = Math.max(...search.matches.map((m: any) => m.confidence || 0));
			ppeScore = Math.max(ppeScore, maxConfidence * 100);
		}
	}

	if (ppeScore > 0) {
		factors.push({
			name: 'Correspondance PPE',
			value: ppeScore,
			weight: SCORING_CONFIG.weights.ppe,
			score: ppeScore * SCORING_CONFIG.weights.ppe,
			description: `Détection de correspondance(s) avec des personnes politiquement exposées`,
			source: 'recherche_ppe'
		});
		totalScore += ppeScore * SCORING_CONFIG.weights.ppe;
	}

	// Score Sanctions
	let sanctionsScore = 0;
	for (const search of sanctionsSearches) {
		if (search.matches && Array.isArray(search.matches) && search.matches.length > 0) {
			sanctionsScore = 100; // Score maximum si présent sur liste de sanctions
			break;
		}
	}

	if (sanctionsScore > 0) {
		factors.push({
			name: 'Liste de sanctions',
			value: sanctionsScore,
			weight: SCORING_CONFIG.weights.sanctions,
			score: sanctionsScore * SCORING_CONFIG.weights.sanctions,
			description: `Présence sur une liste de sanctions internationales`,
			source: 'recherche_sanctions'
		});
		totalScore += sanctionsScore * SCORING_CONFIG.weights.sanctions;
	}

	// Score Asset Freeze
	let assetFreezeScore = 0;
	for (const search of assetFreezeSearches) {
		if (search.matches && Array.isArray(search.matches) && search.matches.length > 0) {
			assetFreezeScore = 100; // Score maximum si gel des avoirs
			break;
		}
	}

	if (assetFreezeScore > 0) {
		factors.push({
			name: 'Gel des avoirs',
			value: assetFreezeScore,
			weight: SCORING_CONFIG.weights.assetFreeze,
			score: assetFreezeScore * SCORING_CONFIG.weights.assetFreeze,
			description: `Présence sur une liste de gel des avoirs`,
			source: 'recherche_asset_freeze'
		});
		totalScore += assetFreezeScore * SCORING_CONFIG.weights.assetFreeze;
	}

	// 2. Facteurs basés sur les données client
	const client = dossier.client;

	// Profession
	const profession = client.profession?.toLowerCase() || '';
	let professionScore = SCORING_CONFIG.factors.profession.default;
	for (const [key, score] of Object.entries(SCORING_CONFIG.factors.profession)) {
		if (key !== 'default' && profession.includes(key)) {
			professionScore = Math.max(professionScore, score);
		}
	}

	if (professionScore > 0) {
		factors.push({
			name: 'Profession à risque',
			value: professionScore,
			weight: 0.15,
			score: professionScore * 0.15,
			description: `Profession présentant un risque élevé: ${client.profession}`,
			source: 'donnees_client'
		});
		totalScore += professionScore * 0.15;
	}

	// Nationalité
	const nationality = client.nationalite.toLowerCase();
	let nationalityScore = SCORING_CONFIG.factors.nationality.default;
	for (const [key, score] of Object.entries(SCORING_CONFIG.factors.nationality)) {
		if (key !== 'default' && nationality.includes(key)) {
			nationalityScore = score;
			break;
		}
	}

	if (nationalityScore > 0) {
		factors.push({
			name: 'Nationalité à risque',
			value: nationalityScore,
			weight: 0.2,
			score: nationalityScore * 0.2,
			description: `Nationalité présentant un risque élevé: ${client.nationalite}`,
			source: 'donnees_client'
		});
		totalScore += nationalityScore * 0.2;
	}

	// Revenus
	if (client.revenus) {
		let revenueScore = SCORING_CONFIG.factors.revenue.default;
		if (client.revenus > 500000) {
			revenueScore = SCORING_CONFIG.factors.revenue.above_500k;
		} else if (client.revenus > 100000) {
			revenueScore = SCORING_CONFIG.factors.revenue.above_100k;
		} else if (client.revenus > 50000) {
			revenueScore = SCORING_CONFIG.factors.revenue.above_50k;
		}

		if (revenueScore > 0) {
			factors.push({
				name: 'Revenus élevés',
				value: revenueScore,
				weight: 0.1,
				score: revenueScore * 0.1,
				description: `Revenus nécessitant une vigilance accrue: ${client.revenus}€`,
				source: 'donnees_client'
			});
			totalScore += revenueScore * 0.1;
		}
	}

	// Âge
	const age = new Date().getFullYear() - client.dateNaissance.getFullYear();
	let ageScore = SCORING_CONFIG.factors.age.default;
	if (age < 18) {
		ageScore = SCORING_CONFIG.factors.age.minor;
	} else if (age > 80) {
		ageScore = SCORING_CONFIG.factors.age.senior;
	}

	if (ageScore > 0) {
		factors.push({
			name: 'Âge nécessitant vigilance',
			value: ageScore,
			weight: 0.05,
			score: ageScore * 0.05,
			description: age < 18 ? 'Client mineur' : 'Client âgé (>80 ans)',
			source: 'donnees_client'
		});
		totalScore += ageScore * 0.05;
	}

	// 3. Facteurs basés sur les documents
	const requiredDocTypes = ['IDENTITE', 'JUSTIFICATIF_DOMICILE', 'RIB'];
	const missingDocs = requiredDocTypes.filter(
		type => !dossier.documents.some((doc: any) => doc.type === type)
	);

	if (missingDocs.length > 0) {
		const missingScore = missingDocs.length * 10;
		factors.push({
			name: 'Documents manquants',
			value: missingScore,
			weight: 0.1,
			score: missingScore * 0.1,
			description: `Documents obligatoires manquants: ${missingDocs.join(', ')}`,
			source: 'documents'
		});
		totalScore += missingScore * 0.1;
	}

	// 4. Facteurs basés sur les exceptions en cours
	if (dossier.exceptions.length > 0) {
		const exceptionScore = Math.min(dossier.exceptions.length * 20, 60);
		factors.push({
			name: 'Exceptions en cours',
			value: exceptionScore,
			weight: 0.15,
			score: exceptionScore * 0.15,
			description: `${dossier.exceptions.length} exception(s) non résolue(s)`,
			source: 'exceptions'
		});
		totalScore += exceptionScore * 0.15;
	}

	// 5. Moyen de paiement
	const validation = dossier.validation as any;
	const moyenPaiement = validation?.moyenPaiement;
	if (moyenPaiement?.type) {
		const mpType = moyenPaiement.type as string;
		const paysCompte = (moyenPaiement.paysCompte || '').toLowerCase();
		let paymentScore = SCORING_CONFIG.factors.payment.default;

		if (mpType === 'especes') {
			paymentScore = SCORING_CONFIG.factors.payment.especes;
		} else if (mpType === 'cheque') {
			paymentScore = SCORING_CONFIG.factors.payment.cheque;
		} else if (mpType === 'lien_paiement') {
			const nbLiens = moyenPaiement.nombreLiensPaiement || 1;
			paymentScore = SCORING_CONFIG.factors.payment.lien_paiement + (nbLiens > 1 ? nbLiens * 5 : 0);
		} else if (mpType === 'virement') {
			const isNonEU = paysCompte && !EU_EEA_COUNTRIES.has(paysCompte);
			paymentScore = isNonEU
				? SCORING_CONFIG.factors.payment.virement_hors_ue
				: SCORING_CONFIG.factors.payment.virement;
		} else if (mpType === 'carte') {
			paymentScore = SCORING_CONFIG.factors.payment.carte;
		}

		if (paymentScore > 0) {
			const label = mpType === 'virement' && paysCompte && !EU_EEA_COUNTRIES.has(paysCompte)
				? `Virement hors UE/EEE (${paysCompte})`
				: `Paiement par ${mpType}`;
			factors.push({
				name: 'Moyen de paiement à risque',
				value: paymentScore,
				weight: 0.25,
				score: paymentScore * 0.25,
				description: label,
				source: 'moyen_paiement'
			});
			totalScore += paymentScore * 0.25;
		}
	}

	// 6. Montant de l'opération
	if (dossier.montantInitial && dossier.montantInitial > 0) {
		const montant = dossier.montantInitial;
		let amountScore = SCORING_CONFIG.factors.amount.default;

		if (montant > 50000) {
			amountScore = SCORING_CONFIG.factors.amount.above_50k;
		} else if (montant > 20000) {
			amountScore = SCORING_CONFIG.factors.amount.above_20k;
		} else if (montant > 10000) {
			amountScore = SCORING_CONFIG.factors.amount.above_10k;
		} else if (montant > 5000) {
			amountScore = SCORING_CONFIG.factors.amount.above_5k;
		}

		if (amountScore > 0) {
			factors.push({
				name: 'Montant opération significatif',
				value: amountScore,
				weight: 0.15,
				score: amountScore * 0.15,
				description: `Montant: ${montant.toLocaleString('fr-FR')}€`,
				source: 'montant_operation'
			});
			totalScore += amountScore * 0.15;
		}
	}

	// 7. Historique de gestion d'entreprises (INSEE / BODACC)
	try {
		const companyResult = await checkCompanyIntelligence({
			nom: client.nom,
			prenom: client.prenom,
			dateNaissance: client.dateNaissance.toLocaleDateString('fr-FR'),
			nationalite: client.nationalite,
			numeroDocument: client.numeroIdentite,
			dateExpiration: '31/12/9999',
			docType: 'cni'
		});

		if (companyResult.status === 'alert' || companyResult.status === 'warning') {
			const companyScore = companyResult.status === 'alert' ? 75 : 35;
			factors.push({
				name: 'Historique d\'entreprises suspect',
				value: companyScore,
				weight: 0.2,
				score: companyScore * 0.2,
				description: companyResult.summary,
				source: 'company_intelligence'
			});
			totalScore += companyScore * 0.2;
		}
	} catch {
		// Service indisponible, facteur ignoré
	}

	// Calcul du niveau de risque
	let niveau: 'FAIBLE' | 'MOYEN' | 'ELEVE' | 'CRITIQUE';
	let recommandation: 'ACCEPTER' | 'REFUSER' | 'VALIDER_MANUELLEMENT';
	let seuilDecision: number;

	if (totalScore <= SCORING_CONFIG.thresholds.low) {
		niveau = 'FAIBLE';
		recommandation = 'ACCEPTER';
		seuilDecision = SCORING_CONFIG.thresholds.low;
	} else if (totalScore <= SCORING_CONFIG.thresholds.medium) {
		niveau = 'MOYEN';
		recommandation = 'VALIDER_MANUELLEMENT';
		seuilDecision = SCORING_CONFIG.thresholds.medium;
	} else if (totalScore <= SCORING_CONFIG.thresholds.high) {
		niveau = 'ELEVE';
		recommandation = 'VALIDER_MANUELLEMENT';
		seuilDecision = SCORING_CONFIG.thresholds.high;
	} else {
		niveau = 'CRITIQUE';
		recommandation = 'REFUSER';
		seuilDecision = 100;
	}

	// Justification
	const mainFactors = factors
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map(f => f.name);

	const justification = `Score de risque: ${totalScore.toFixed(1)}/100. ` +
		`Niveau: ${niveau}. ` +
		`Principaux facteurs: ${mainFactors.join(', ') || 'Aucun facteur de risque majeur'}.`;

	return {
		scoreTotal: Math.round(totalScore * 10) / 10,
		niveau,
		recommandation,
		justification,
		facteurs: factors,
		seuilDecision
	};
}

// POST /api/scoring/dossiers/:dossierId - Calculer le scoring d'un dossier
router.post('/dossiers/:dossierId',
	authenticateToken,
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;
		const { forceRecalculation } = scoringRequestSchema.parse(req.body);
		const userId = req.user!.id;

		// Vérifier s'il existe déjà un scoring
		const existingScoring = await prisma.scoring.findUnique({
			where: { dossierId }
		});

		if (existingScoring && !forceRecalculation) {
			return res.json({
				success: true,
				data: { scoring: existingScoring },
				message: 'Scoring existant retourné (utilisez forceRecalculation pour recalculer)'
			});
		}

		// Calcul du scoring
		const scoringResult = await calculateRiskScore(dossierId);

		// Sauvegarde ou mise à jour du scoring
		const scoring = existingScoring
			? await prisma.scoring.update({
				where: { dossierId },
				data: {
					scoreTotal: scoringResult.scoreTotal,
					niveau: scoringResult.niveau,
					facteurs: scoringResult.facteurs as any,
					recommandation: scoringResult.recommandation,
					justification: scoringResult.justification,
					seuilDecision: scoringResult.seuilDecision,
					calculatedAt: new Date()
				}
			})
			: await prisma.scoring.create({
				data: {
					dossierId,
					scoreTotal: scoringResult.scoreTotal,
					niveau: scoringResult.niveau,
					facteurs: scoringResult.facteurs as any,
					recommandation: scoringResult.recommandation,
					justification: scoringResult.justification,
					seuilDecision: scoringResult.seuilDecision
				}
			});

		// Création d'une exception si le score est élevé
		if (scoringResult.niveau === 'ELEVE' || scoringResult.niveau === 'CRITIQUE') {
			const existingException = await prisma.exception.findFirst({
				where: {
					dossierId,
					type: 'SCORING_ELEVE',
					status: { in: ['EN_ATTENTE', 'EN_COURS_TRAITEMENT'] }
				}
			});

			if (!existingException) {
				await prisma.exception.create({
					data: {
						dossierId,
						type: 'SCORING_ELEVE',
						description: `Score de risque ${scoringResult.niveau.toLowerCase()} détecté (${scoringResult.scoreTotal}/100)`,
						details: {
							scoringId: scoring.id,
							scoreTotal: scoringResult.scoreTotal,
							niveau: scoringResult.niveau,
							recommandation: scoringResult.recommandation,
							principauxFacteurs: scoringResult.facteurs
								.sort((a, b) => b.score - a.score)
								.slice(0, 3)
								.map(f => ({ name: f.name, score: f.score }))
						},
						priority: scoringResult.niveau === 'CRITIQUE' ? 'CRITIQUE' : 'HAUTE',
						status: 'EN_ATTENTE'
					}
				});
			}
		}

		logScoringEvent({
			action: 'scoring_calculated',
			dossierId,
			userId,
			details: {
				scoreTotal: scoringResult.scoreTotal,
				niveau: scoringResult.niveau,
				recommandation: scoringResult.recommandation,
				facteurCount: scoringResult.facteurs.length,
				isRecalculation: !!existingScoring
			}
		});

		logAuditEvent({
			userId,
			action: existingScoring ? 'UPDATE' : 'CREATE',
			resource: 'scoring',
			resourceId: scoring.id,
			oldValues: existingScoring || undefined,
			newValues: scoring,
			ipAddress: req.ip,
			metadata: { dossierId }
		});

		res.json({
			success: true,
			data: { scoring }
		});
	})
);

// GET /api/scoring/dossiers/:dossierId - Récupérer le scoring d'un dossier
router.get('/dossiers/:dossierId',
	authenticateToken,
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;

		const scoring = await prisma.scoring.findUnique({
			where: { dossierId }
		});

		if (!scoring) {
			throw new ValidationError('Aucun scoring disponible pour ce dossier');
		}

		res.json({
			success: true,
			data: { scoring }
		});
	})
);

// GET /api/scoring/dossiers/:dossierId/preview - Aperçu du scoring sans sauvegarde
router.get('/dossiers/:dossierId/preview',
	authenticateToken,
	requireDossierAccess,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const { dossierId } = req.params;

		const scoringResult = await calculateRiskScore(dossierId);

		res.json({
			success: true,
			data: {
				preview: scoringResult,
				warning: 'Ceci est un aperçu. Le scoring n\'a pas été sauvegardé.'
			}
		});
	})
);

// GET /api/scoring/stats - Statistiques globales de scoring
router.get('/stats',
	authenticateToken,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		const userId = req.user!.id;
		const userRole = req.user!.role;

		// Filtrage par permissions
		let whereClause: any = {};
		if (userRole === 'CONSEILLER' || userRole === 'CAISSE') {
			whereClause = {
				dossier: {
					OR: [
						{ createdById: userId },
						{ assignedToId: userId }
					]
				}
			};
		}

		const [
			totalScorings,
			distributionParNiveau,
			scoresMoyens,
			scoringsRecents
		] = await Promise.all([
			// Total des scorings
			prisma.scoring.count({ where: whereClause }),

			// Distribution par niveau de risque
			prisma.scoring.groupBy({
				by: ['niveau'],
				where: whereClause,
				_count: true
			}),

			// Scores moyens par niveau
			prisma.scoring.groupBy({
				by: ['niveau'],
				where: whereClause,
				_avg: {
					scoreTotal: true
				}
			}),

			// Scorings récents (30 derniers jours)
			prisma.scoring.count({
				where: {
					...whereClause,
					calculatedAt: {
						gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
					}
				}
			})
		]);

		const stats = {
			total: totalScorings,
			recent30days: scoringsRecents,
			distribution: distributionParNiveau.reduce((acc: Record<string, number>, item: any) => {
				acc[item.niveau] = item._count;
				return acc;
			}, {} as Record<string, number>),
			averageScores: scoresMoyens.reduce((acc: Record<string, number>, item: any) => {
				acc[item.niveau] = Math.round((item._avg.scoreTotal || 0) * 10) / 10;
				return acc;
			}, {} as Record<string, number>)
		};

		res.json({
			success: true,
			data: { stats }
		});
	})
);

// GET /api/scoring/config - Configuration du scoring (lecture seule)
router.get('/config',
	authenticateToken,
	asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
		res.json({
			success: true,
			data: {
				config: {
					weights: SCORING_CONFIG.weights,
					thresholds: SCORING_CONFIG.thresholds,
					factors: Object.keys(SCORING_CONFIG.factors)
				}
			}
		});
	})
);

export default router;
