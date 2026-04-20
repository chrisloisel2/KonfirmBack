/**
 * Service de vérification des seuils LCB-FT selon règles GODECHOT PAULIET
 * Implémentation conforme au cahier des charges GODECHOT PAULIET
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logResearchEvent } from '../utils/logger';
import prisma from '../lib/prisma';

export interface SeuilCheckResult {
	clientType: 'occasionnel' | 'relation_affaires';
	seuilApplicable: number; // 15000 ou 10000
	montantCumule12Mois: number;
	montantCumule4Semaines: number;
	requiredDialigences: string[];
	justification: string;
}

export interface GelAvoirsResult {
	isListed: boolean;
	matches?: Array<{ name: string; details: string; listType: string }>;
	confidence: number;
	checkedAt: Date;
	source: 'DG_TRESOR';
}

/**
 * Détermine le type de client et les seuils applicables
 * Règles GODECHOT PAULIET:
 * - Client occasionnel: primo-acheteur (aucun achat 12 mois glissants)
 * - Relation d'affaires: 2ème achat OU achat dans 12 mois précédents
 * - Transactions liées: 4 semaines glissantes (pas 12 mois)
 */
export async function checkSeuilsLcbFt(
	numeroIdentite: string,
	montantTransaction: number,
	userId?: string
): Promise<SeuilCheckResult> {

	// Périodes de référence
	const maintenant = new Date();
	const il12Mois = new Date(maintenant.getTime() - 365 * 24 * 60 * 60 * 1000);
	const il4Semaines = new Date(maintenant.getTime() - 28 * 24 * 60 * 60 * 1000);

	// Rechercher client existant
	const client = await prisma.client.findUnique({
		where: { numeroIdentite },
		include: {
			dossiers: {
				where: { status: { in: ['VALIDE', 'EN_COURS', 'ATTENTE_VALIDATION'] } },
				orderBy: { dateOuverture: 'desc' }
			}
		}
	});

	// Calculs historiques
	const dossiersValides = client?.dossiers ?? [];
	const dossiers12Mois = dossiersValides.filter((d: any) =>
		d.dateOuverture && d.dateOuverture >= il12Mois
	);
	const dossiers4Semaines = dossiersValides.filter((d: any) =>
		d.dateOuverture && d.dateOuverture >= il4Semaines
	);

	const montantCumule12Mois = dossiers12Mois.reduce(
		(sum: number, d: any) => sum + (d.montantInitial ?? 0), 0
	);
	const montantCumule4Semaines = dossiers4Semaines.reduce(
		(sum: number, d: any) => sum + (d.montantInitial ?? 0), 0
	);

	// Détermination type client selon règles GODECHOT PAULIET
	const estClientOccasionnel = dossiers12Mois.length === 0;
	const clientType: 'occasionnel' | 'relation_affaires' =
		estClientOccasionnel ? 'occasionnel' : 'relation_affaires';

	// Seuils applicables
	const seuilApplicable = clientType === 'occasionnel' ? 15000 : 10000;
	const montantReference = clientType === 'occasionnel'
		? montantTransaction
		: montantCumule4Semaines + montantTransaction;

	// Diligences requises
	const requiredDialigences: string[] = [];
	let justification = '';

	if (montantReference >= seuilApplicable) {
		requiredDialigences.push('identification_complete');
		requiredDialigences.push('verification_piece_identite');
		requiredDialigences.push('recherches_ppe');
		requiredDialigences.push('recherches_gel_avoirs');
		requiredDialigences.push('recherches_pays_risque');
		requiredDialigences.push('fiche_excel_lcb_ft');

		if (clientType === 'occasionnel') {
			justification = `Client occasionnel dépassant seuil 15 000€ (${montantTransaction}€)`;
		} else {
			justification = `Relations d'affaires dépassant seuil 10 000€ sur 4 semaines (${montantReference}€)`;
		}
	} else {
		requiredDialigences.push('verification_piece_identite');
		requiredDialigences.push('recherches_gel_avoirs');
		justification = `Sous seuil LCB-FT - Diligences minimales uniquement`;
	}

	// Log de la vérification des seuils
	if (userId) {
		logResearchEvent({
			action: 'search',
			searchType: 'seuils_verification',
			query: `${clientType}_${montantReference}`,
			userId,
			details: {
				clientType,
				seuilApplicable,
				montantTransaction,
				montantCumule12Mois,
				montantCumule4Semaines,
				requiredDialigences: requiredDialigences.length
			}
		});
	}

	return {
		clientType,
		seuilApplicable,
		montantCumule12Mois,
		montantCumule4Semaines,
		requiredDialigences,
		justification
	};
}

/**
 * Vérification spécifique gel des avoirs DG Trésor
 * URL: https://gels-avoirs.dgtresor.gouv.fr/List
 * Conforme aux procédures GODECHOT PAULIET section IV.j)
 */
export async function checkGelAvoirsDGTresor(
	nomPrenom: string,
	userId?: string
): Promise<GelAvoirsResult> {

	const startTime = Date.now();

	try {
		// Recherche sur le registre officiel DG Trésor
		const response = await axios.post('https://gels-avoirs.dgtresor.gouv.fr/List',
			new URLSearchParams({
				'nom': nomPrenom.trim(),
				'search': 'Rechercher'
			}),
			{
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'User-Agent': 'Mozilla/5.0 (compatible; KonfirmLCBFT/1.0)'
				},
				timeout: 8000
			}
		);

		const html = response.data;
		const $ = cheerio.load(html);

		// Parser les résultats de recherche
		const matches: Array<{ name: string; details: string; listType: string }> = [];

		// Recherche des lignes de résultats dans le tableau
		$('table tr').each((index, element) => {
			if (index === 0) return; // Skip header

			const cells = $(element).find('td');
			if (cells.length >= 3) {
				const name = $(cells[1]).text().trim();
				const details = $(cells[2]).text().trim();
				const listType = $(cells[0]).text().trim();

				if (name && name.toLowerCase().includes(nomPrenom.toLowerCase())) {
					matches.push({ name, details, listType });
				}
			}
		});

		const isListed = matches.length > 0;
		const confidence = isListed ? 0.95 : 0.90;

		// Log de la recherche
		if (userId) {
			logResearchEvent({
				action: 'search',
				searchType: 'gel_avoirs_dg_tresor',
				query: nomPrenom,
				userId,
				results: matches.length,
				hasAlerts: isListed,
				details: {
					duration: Date.now() - startTime,
					matches: matches.length,
					source: 'DG_TRESOR'
				}
			});
		}

		return {
			isListed,
			matches: matches.length > 0 ? matches : undefined,
			confidence,
			checkedAt: new Date(),
			source: 'DG_TRESOR'
		};

	} catch (error) {
		console.error('Erreur vérification gel avoirs DG Trésor:', error);

		if (userId) {
			logResearchEvent({
				action: 'search',
				searchType: 'gel_avoirs_dg_tresor',
				query: nomPrenom,
				userId,
				results: 0,
				hasAlerts: false,
				details: {
					error: error instanceof Error ? error.message : 'Unknown error',
					duration: Date.now() - startTime
				}
			});
		}

		return {
			isListed: false,
			confidence: 0,
			checkedAt: new Date(),
			source: 'DG_TRESOR'
		};
	}
}

/**
 * Surveillance vigilance constante pour relations d'affaires
 * Conforme aux procédures GODECHOT PAULIET section VI
 */
export async function checkVigilanceConstante(
	clientId: string,
	userId?: string
): Promise<{
	requiresUpdate: boolean;
	changes: Array<{ type: string; description: string }>;
	lastCheck: Date;
}> {

	const client = await prisma.client.findUnique({
		where: { id: clientId },
		include: {
			dossiers: {
				orderBy: { createdAt: 'desc' },
				take: 1
			}
		}
	});

	if (!client) {
		throw new Error('Client non trouvé');
	}

	const changes: Array<{ type: string; description: string }> = [];
	let requiresUpdate = false;

	// Vérifier si le client est devenu PPE depuis dernière vérification
	const lastDossier = client.dossiers[0];
	if (lastDossier && lastDossier.createdAt) {
		const daysSinceLastCheck = Math.floor(
			(Date.now() - lastDossier.createdAt.getTime()) / (24 * 60 * 60 * 1000)
		);

		// Vérification requise si > 30 jours depuis dernier contrôle
		if (daysSinceLastCheck > 30) {
			requiresUpdate = true;
			changes.push({
				type: 'verification_ppe_required',
				description: `Vérification PPE requise (${daysSinceLastCheck} jours depuis dernier contrôle)`
			});

			changes.push({
				type: 'verification_pays_required',
				description: 'Vérification mise à jour listes GAFI/UE requise'
			});
		}
	}

	// Log vigilance constante
	if (userId) {
		logResearchEvent({
			action: 'search',
			searchType: 'vigilance_constante',
			query: clientId,
			userId,
			details: {
				clientId,
				requiresUpdate,
				changesCount: changes.length,
				lastCheck: lastDossier?.createdAt
			}
		});
	}

	return {
		requiresUpdate,
		changes,
		lastCheck: lastDossier?.createdAt || new Date()
	};
}
