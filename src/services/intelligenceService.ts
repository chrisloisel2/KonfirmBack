/**
 * Intelligence Service — Rapports de Renseignement Complets
 *
 * Génère un rapport d'intelligence exhaustif combinant:
 *   - Toutes les sources OSINT (25+)
 *   - Données internes (dossiers, exceptions, scoring, TRACFIN)
 *   - Analyse des connexions et réseaux
 *   - Profil de risque synthétisé
 *   - Timeline des événements significatifs
 *   - Recommandations conformité
 *   - Indicateurs comportementaux
 *   - Indice d'exposition politique (PEP)
 *   - Score de vigilance renforcée
 */

import prisma from '../lib/prisma';
import { runOsintMega, OsintReport, OsintQuery } from './osintMegaService';
import { getEntityTimeline, TimelineEvent } from './universalSearchService';
import { logSystemEvent } from '../utils/logger';

export interface IntelligenceReportInput {
	nom: string;
	prenom?: string;
	dateNaissance?: string;
	nationalite?: string;
	pays?: string;
	entreprise?: string;
	siret?: string;
	subjectType: 'PERSON' | 'COMPANY' | 'MIXED';
	clientId?: string;
	dossierId?: string;
	requestedBy: string;
}

export interface IntelligenceReportOutput {
	id?: string;
	subject: {
		nom: string;
		prenom?: string;
		fullName: string;
		type: string;
		dateNaissance?: string;
		nationalite?: string;
		pays?: string;
		entreprise?: string;
	};

	// Résumé exécutif
	executiveSummary: {
		overallRisk: string;
		riskScore: number;
		pepScore: number;
		sanctionsExposure: boolean;
		assetFreezeExposure: boolean;
		judicialRecord: boolean;
		negativePress: boolean;
		keyAlerts: string[];
		recommendation: string;
		vigilanceLevel: 'SIMPLIFIEE' | 'STANDARD' | 'RENFORCEE' | 'REFUS_RECOMMANDE';
	};

	// Sections détaillées
	sections: {
		identite:           IdentiteSection;
		sanctionsEtGel:     SanctionsSection;
		ppe:                PPESection;
		judiciaire:         JudiciaireSection;
		entreprises:        EntreprisesSection;
		repuationPresse:    PressSection;
		risquePays:         RisquesPaysSection;
		interne:            InterneSection;
		reseauConnexions:   ReseauSection;
		timeline:           TimelineSection;
		scoring:            ScoringSection;
	};

	osintReport:    OsintReport;
	generatedAt:    Date;
	expiresAt:      Date;
	durationMs:     number;
	requestedBy:    string;
}

interface IdentiteSection {
	status: 'VERIFIED' | 'UNVERIFIED' | 'INCONSISTENCIES';
	documents: any[];
	aliases: string[];
	birthDetails: any;
	addresses: string[];
	contacts: string[];
	notes: string[];
}

interface SanctionsSection {
	hasSanctions: boolean;
	hasAssetFreeze: boolean;
	matches: any[];
	sources: string[];
	lastChecked: Date;
	notes: string[];
}

interface PPESection {
	isPPE: boolean;
	pepScore: number;  // 0-100
	politicalFunctions: string[];
	familyConnections: string[];
	sources: string[];
	notes: string[];
}

interface JudiciaireSection {
	hasRecord: boolean;
	decisions: any[];
	sources: string[];
	notes: string[];
}

interface EntreprisesSection {
	companies: any[];
	totalCompanies: number;
	dissolutions: number;
	suspiciousStructures: string[];
	beneficialOwnership: any[];
	notes: string[];
}

interface PressSection {
	articles: any[];
	sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'VERY_NEGATIVE';
	negativeKeywords: string[];
	sources: string[];
	notes: string[];
}

interface RisquesPaysSection {
	flaggedCountries: string[];
	fatfStatus: string[];
	corruptionIndex: any[];
	notes: string[];
}

interface InterneSection {
	hasDossiers: boolean;
	dossierCount: number;
	dossiers: any[];
	totalExceptions: number;
	criticalExceptions: number;
	hasTracfin: boolean;
	tracfinCount: number;
	maxRiskScore: number;
	riskHistory: any[];
	notes: string[];
}

interface ReseauSection {
	connectedPersons: string[];
	connectedCompanies: string[];
	sharedAddresses: string[];
	suspiciousLinks: string[];
	notes: string[];
}

interface TimelineSection {
	events: TimelineEvent[];
	firstActivity?: Date;
	lastActivity?: Date;
	totalEvents: number;
}

interface ScoringSection {
	latestScore?: number;
	latestLevel?: string;
	scoreHistory: any[];
	riskFactors: string[];
	recommendation: string;
}

// ─── Generate full intelligence report ──────────────────────────────────────

export async function generateIntelligenceReport(
	input: IntelligenceReportInput
): Promise<IntelligenceReportOutput> {
	const start = Date.now();
	const fullName = input.prenom ? `${input.prenom} ${input.nom}` : input.nom;

	logSystemEvent({
		action: 'intelligence_report_start',
		component: 'intelligenceService',
		details: { subject: fullName, type: input.subjectType },
		severity: 'info',
	});

	// Run OSINT and internal queries in parallel
	const osintQuery: OsintQuery = {
		nom: input.nom,
		prenom: input.prenom,
		dateNaissance: input.dateNaissance,
		nationalite: input.nationalite,
		pays: input.pays,
		entreprise: input.entreprise,
		siret: input.siret,
		type: input.subjectType === 'COMPANY' ? 'COMPANY' : 'PERSON',
		confidenceThreshold: 0.72,
	};

	const [osintReport, internalData, timelineEvents] = await Promise.all([
		runOsintMega(osintQuery),
		loadInternalData(input),
		input.clientId || input.dossierId
			? getEntityTimeline({ clientId: input.clientId, dossierId: input.dossierId })
			: Promise.resolve([]),
	]);

	// Build sections
	const sections = buildSections(input, osintReport, internalData, timelineEvents);

	// Compute executive summary
	const executiveSummary = buildExecutiveSummary(osintReport, sections, internalData);

	const report: IntelligenceReportOutput = {
		subject: {
			nom: input.nom,
			prenom: input.prenom,
			fullName,
			type: input.subjectType,
			dateNaissance: input.dateNaissance,
			nationalite: input.nationalite,
			pays: input.pays,
			entreprise: input.entreprise,
		},
		executiveSummary,
		sections,
		osintReport,
		generatedAt: new Date(),
		expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), // 30 days
		durationMs: Date.now() - start,
		requestedBy: input.requestedBy,
	};

	// Persist report
	try {
		const saved = await (prisma as any).intelligenceReport.create({
			data: {
				userId: input.requestedBy,
				subjectName: fullName,
				subjectType: input.subjectType,
				queryParams: input as any,
				sections: sections as any,
				overallRisk: executiveSummary.overallRisk,
				riskScore: executiveSummary.riskScore,
				sourcesQueried: osintReport.sources.map(s => s.id),
				sourcesHit: osintReport.sources.filter(s => s.matchCount > 0).map(s => s.id),
				totalMatches: osintReport.totalMatches,
				summary: executiveSummary.keyAlerts.join(' | '),
				expiresAt: report.expiresAt,
			}
		});
		report.id = saved.id;
	} catch (e) {
		logSystemEvent({ action: 'intelligence_report_save_error', component: 'intelligenceService', details: { error: String(e) }, severity: 'warn' });
	}

	logSystemEvent({
		action: 'intelligence_report_complete',
		component: 'intelligenceService',
		details: {
			subject: fullName,
			durationMs: report.durationMs,
			overallRisk: executiveSummary.overallRisk,
			totalMatches: osintReport.totalMatches,
		},
		severity: 'info',
	});

	return report;
}

// ─── Load internal data ───────────────────────────────────────────────────────

async function loadInternalData(input: IntelligenceReportInput) {
	const result: {
		client: any;
		dossiers: any[];
		exceptions: any[];
		scorings: any[];
		tracfins: any[];
		documents: any[];
		recherches: any[];
	} = {
		client: null,
		dossiers: [],
		exceptions: [],
		scorings: [],
		tracfins: [],
		documents: [],
		recherches: [],
	};

	if (input.clientId) {
		result.client = await (prisma as any).client.findUnique({
			where: { id: input.clientId }
		});
	}

	// Find client by name if no ID provided
	if (!result.client && input.nom) {
		result.client = await (prisma as any).client.findFirst({
			where: {
				nom: { contains: input.nom, mode: 'insensitive' },
				...(input.prenom ? { prenom: { contains: input.prenom, mode: 'insensitive' } } : {}),
			}
		});
	}

	const clientId = result.client?.id || input.clientId;

	if (clientId) {
		result.dossiers = await (prisma as any).dossier.findMany({
			where: { clientId },
			include: {
				exceptions: true,
				recherches: true,
				tracfinDeclarations: true,
				documents: { select: { id: true, type: true, isVerified: true, originalName: true, ocrText: true } },
			}
		});

		result.exceptions = result.dossiers.flatMap((d: any) => d.exceptions || []);
		result.recherches = result.dossiers.flatMap((d: any) => d.recherches || []);
		result.tracfins   = result.dossiers.flatMap((d: any) => d.tracfinDeclarations || []);
		result.documents  = result.dossiers.flatMap((d: any) => d.documents || []);

		// Scoring for each dossier
		for (const d of result.dossiers) {
			const scoring = await (prisma as any).scoring.findUnique({
				where: { dossierId: d.id }
			});
			if (scoring) result.scorings.push(scoring);
		}
	}

	return result;
}

// ─── Build sections ───────────────────────────────────────────────────────────

function buildSections(
	input: IntelligenceReportInput,
	osint: OsintReport,
	internal: any,
	timeline: TimelineEvent[]
): IntelligenceReportOutput['sections'] {

	const sanctionsSources = osint.sources.filter(s => s.category === 'SANCTIONS' && s.matchCount > 0);
	const gelSources       = osint.sources.filter(s => s.category === 'GEL_AVOIRS' && s.matchCount > 0);
	const entrepriseSrcs   = osint.sources.filter(s => s.category === 'ENTREPRISE');
	const presseSources    = osint.sources.filter(s => s.category === 'PRESSE' && s.matchCount > 0);
	const judiciaireSrcs   = osint.sources.filter(s => s.category === 'JUDICIAIRE' && s.matchCount > 0);
	const paysRisqueSrcs   = osint.sources.filter(s => s.category === 'RISQUE_PAYS' && s.matchCount > 0);
	const encyclopedique   = osint.sources.find(s => s.id === 'wikipedia' || s.id === 'duckduckgo');

	// Identité
	const identite: IdentiteSection = {
		status: internal.documents?.some((d: any) => d.isVerified) ? 'VERIFIED' : 'UNVERIFIED',
		documents: internal.documents?.map((d: any) => ({
			type: d.type,
			verified: d.isVerified,
			fileName: d.originalName,
		})) || [],
		aliases: osint.sources.flatMap(s => s.results.flatMap(r => r.aliases || [])),
		birthDetails: { dateNaissance: input.dateNaissance, nationalite: input.nationalite },
		addresses: internal.client ? [internal.client.adresseComplete].filter(Boolean) : [],
		contacts: [internal.client?.email, internal.client?.telephone].filter(Boolean),
		notes: [],
	};

	// Sanctions
	const allSanctionsMatches = [...sanctionsSources, ...gelSources].flatMap(s => s.results);
	const sanctionsEtGel: SanctionsSection = {
		hasSanctions: sanctionsSources.length > 0,
		hasAssetFreeze: gelSources.length > 0,
		matches: allSanctionsMatches,
		sources: [...sanctionsSources, ...gelSources].map(s => s.label),
		lastChecked: new Date(),
		notes: allSanctionsMatches.length > 0
			? [`${allSanctionsMatches.length} correspondance(s) trouvée(s) sur listes de sanctions/gel`]
			: ['Aucune correspondance sur les listes de sanctions/gel des avoirs'],
	};

	// PPE
	const wikiSrc = osint.sources.find(s => s.id === 'wikipedia');
	const isPPE = wikiSrc?.results.some(r => (r.details as any)?.isPEP) || false;
	const interpol = osint.sources.find(s => s.id === 'interpol');
	const ppe: PPESection = {
		isPPE: isPPE || (internal.client?.personnePublique || false),
		pepScore: computePEPScore(input, osint, internal),
		politicalFunctions: wikiSrc?.results.flatMap(r => (r.details as any)?.isPEP ? [(r.details as any).extract?.substring(0, 100)] : []) || [],
		familyConnections: [],
		sources: [wikiSrc?.label, 'Données internes'].filter(Boolean) as string[],
		notes: [
			isPPE ? '⚠️ Personne Politiquement Exposée identifiée via Wikipedia' : '',
			internal.client?.personnePublique ? '⚠️ Marqué PPE en base interne' : '',
		].filter(Boolean),
	};

	// Judiciaire
	const judiciaireSection: JudiciaireSection = {
		hasRecord: judiciaireSrcs.length > 0,
		decisions: judiciaireSrcs.flatMap(s => s.results),
		sources: judiciaireSrcs.map(s => s.label),
		notes: judiciaireSrcs.length > 0
			? [`${judiciaireSrcs.length} source(s) judiciaire(s) avec correspondances`]
			: [],
	};

	// Entreprises
	const entreprises: EntreprisesSection = {
		companies: entrepriseSrcs.flatMap(s => s.results),
		totalCompanies: entrepriseSrcs.reduce((sum, s) => sum + s.matchCount, 0),
		dissolutions: entrepriseSrcs.flatMap(s => s.results).filter(r =>
			(r.details as any)?.status?.includes('liquid') ||
			(r.details as any)?.statut?.includes('liquidation') ||
			(r.details as any)?.dissolvedOn
		).length,
		suspiciousStructures: [],
		beneficialOwnership: entrepriseSrcs.flatMap(s =>
			s.results.flatMap(r => (r.details as any)?.beneficiaires || [])
		),
		notes: [],
	};

	// Presse
	const negativeKeywords = presseSources.flatMap(s =>
		s.results.filter(r => r.severity !== 'LOW').map(r => r.snippet || '')
	);
	const hasNegativePress = presseSources.some(s =>
		s.results.some(r => r.severity === 'HIGH' || r.severity === 'CRITICAL')
	);
	const presse: PressSection = {
		articles: presseSources.flatMap(s => s.results),
		sentiment: hasNegativePress ? 'NEGATIVE' : presseSources.length > 0 ? 'NEUTRAL' : 'NEUTRAL',
		negativeKeywords,
		sources: presseSources.map(s => s.label),
		notes: hasNegativePress ? ['Articles négatifs ou suspects détectés dans la presse'] : [],
	};

	// Risque pays
	const risquePays: RisquesPaysSection = {
		flaggedCountries: paysRisqueSrcs.flatMap(s => s.results.map(r => r.name)),
		fatfStatus: paysRisqueSrcs.filter(s => s.id === 'fatf').flatMap(s =>
			s.results.map(r => `${r.name}: ${(r.details as any)?.status}`)
		),
		corruptionIndex: paysRisqueSrcs.filter(s => s.id === 'transparency_intl').flatMap(s =>
			s.results.map(r => ({ country: r.name, cpi: (r.details as any)?.cpiScore }))
		),
		notes: paysRisqueSrcs.length > 0
			? [`${paysRisqueSrcs.flatMap(s => s.results).length} pays à risque identifié(s)`]
			: [],
	};

	// Interne
	const maxScore = internal.scorings.length > 0
		? Math.max(...internal.scorings.map((s: any) => s.scoreTotal))
		: 0;
	const criticalExceptions = internal.exceptions.filter((e: any) => e.priority === 'CRITIQUE').length;
	const interne: InterneSection = {
		hasDossiers: internal.dossiers.length > 0,
		dossierCount: internal.dossiers.length,
		dossiers: internal.dossiers.map((d: any) => ({
			id: d.id,
			numero: d.numero,
			status: d.status,
			type: d.typeOuverture,
			montant: d.montantInitial,
			createdAt: d.createdAt,
			exceptionCount: d.exceptions?.length || 0,
		})),
		totalExceptions: internal.exceptions.length,
		criticalExceptions,
		hasTracfin: internal.tracfins.length > 0,
		tracfinCount: internal.tracfins.length,
		maxRiskScore: maxScore,
		riskHistory: internal.scorings.map((s: any) => ({
			dossierId: s.dossierId,
			score: s.scoreTotal,
			niveau: s.niveau,
			date: s.calculatedAt,
		})),
		notes: [
			internal.tracfins.length > 0 ? `⚠️ ${internal.tracfins.length} déclaration(s) TRACFIN` : '',
			criticalExceptions > 0 ? `⚠️ ${criticalExceptions} exception(s) critique(s)` : '',
			maxScore >= 85 ? `⚠️ Score de risque maximum: ${maxScore}/100` : '',
		].filter(Boolean),
	};

	// Réseau
	const reseauSection: ReseauSection = {
		connectedPersons: [],
		connectedCompanies: entreprises.companies.map(c => c.name),
		sharedAddresses: [],
		suspiciousLinks: [],
		notes: [],
	};

	// Timeline
	const timelineSection: TimelineSection = {
		events: timeline,
		firstActivity: timeline.length > 0 ? timeline[timeline.length - 1].timestamp : undefined,
		lastActivity: timeline.length > 0 ? timeline[0].timestamp : undefined,
		totalEvents: timeline.length,
	};

	// Scoring
	const latestScoring = internal.scorings.sort((a: any, b: any) =>
		new Date(b.calculatedAt).getTime() - new Date(a.calculatedAt).getTime()
	)[0];
	const scoringSection: ScoringSection = {
		latestScore: latestScoring?.scoreTotal,
		latestLevel: latestScoring?.niveau,
		scoreHistory: internal.scorings,
		riskFactors: latestScoring ? JSON.parse(JSON.stringify(latestScoring.facteurs || [])) : [],
		recommendation: latestScoring?.recommandation || 'Aucun scoring disponible',
	};

	return {
		identite,
		sanctionsEtGel,
		ppe,
		judiciaire: judiciaireSection,
		entreprises,
		repuationPresse: presse,
		risquePays,
		interne,
		reseauConnexions: reseauSection,
		timeline: timelineSection,
		scoring: scoringSection,
	};
}

// ─── Executive summary ────────────────────────────────────────────────────────

function buildExecutiveSummary(
	osint: OsintReport,
	sections: IntelligenceReportOutput['sections'],
	internal: any
): IntelligenceReportOutput['executiveSummary'] {
	const keyAlerts: string[] = [];

	if (sections.sanctionsEtGel.hasSanctions)    keyAlerts.push('🚨 Présent sur liste de sanctions');
	if (sections.sanctionsEtGel.hasAssetFreeze)   keyAlerts.push('🚨 Gel des avoirs identifié');
	if (sections.ppe.isPPE)                        keyAlerts.push('⚠️ Personne Politiquement Exposée');
	if (sections.judiciaire.hasRecord)             keyAlerts.push('⚠️ Mentions judiciaires trouvées');
	if (sections.interne.hasTracfin)               keyAlerts.push(`⚠️ ${sections.interne.tracfinCount} déclaration(s) TRACFIN`);
	if (sections.interne.criticalExceptions > 0)   keyAlerts.push(`⚠️ ${sections.interne.criticalExceptions} exception(s) critique(s)`);
	if (sections.repuationPresse.sentiment === 'NEGATIVE') keyAlerts.push('⚠️ Réputation négative dans la presse');
	if (sections.risquePays.flaggedCountries.length > 0)   keyAlerts.push(`⚠️ Connexions pays à risque: ${sections.risquePays.flaggedCountries.join(', ')}`);

	const riskScore = osint.riskScore;
	const overallRisk =
		sections.sanctionsEtGel.hasSanctions || sections.sanctionsEtGel.hasAssetFreeze ? 'CRITIQUE' :
		riskScore >= 70 ? 'ELEVE'   :
		riskScore >= 40 ? 'MOYEN'   :
		'FAIBLE';

	const vigilanceLevel =
		overallRisk === 'CRITIQUE' ? 'REFUS_RECOMMANDE' :
		overallRisk === 'ELEVE'    ? 'RENFORCEE' :
		overallRisk === 'MOYEN'    ? 'STANDARD'  :
		'SIMPLIFIEE';

	const recommendation =
		overallRisk === 'CRITIQUE' ? 'REFUS RECOMMANDÉ — Présence sur liste(s) de sanctions ou gel des avoirs. Contact TRACFIN obligatoire.' :
		overallRisk === 'ELEVE'    ? 'VIGILANCE RENFORCÉE — Mesures KYC renforcées requises. Soumettre à validation responsable conformité.' :
		overallRisk === 'MOYEN'    ? 'VIGILANCE STANDARD — Surveillance continue recommandée. Justificatifs complémentaires à recueillir.' :
		'VIGILANCE SIMPLIFIÉE — Profil de risque faible. Surveillance ordinaire.';

	return {
		overallRisk,
		riskScore,
		pepScore: sections.ppe.pepScore,
		sanctionsExposure: sections.sanctionsEtGel.hasSanctions,
		assetFreezeExposure: sections.sanctionsEtGel.hasAssetFreeze,
		judicialRecord: sections.judiciaire.hasRecord,
		negativePress: sections.repuationPresse.sentiment === 'NEGATIVE',
		keyAlerts,
		recommendation,
		vigilanceLevel,
	};
}

// ─── PEP score ────────────────────────────────────────────────────────────────

function computePEPScore(input: IntelligenceReportInput, osint: OsintReport, internal: any): number {
	let score = 0;

	if (internal.client?.personnePublique) score += 50;

	const wiki = osint.sources.find(s => s.id === 'wikipedia');
	if (wiki?.results.some(r => (r.details as any)?.isPEP)) score += 40;

	const ddg = osint.sources.find(s => s.id === 'duckduckgo');
	if (ddg?.results.some(r => (r.details as any)?.isPEP)) score += 20;

	// Keywords in press
	const pressMatches = osint.sources.filter(s => s.category === 'PRESSE');
	const pepKeywords = ['ministre', 'député', 'sénateur', 'président', 'maire', 'général', 'préfet'];
	for (const src of pressMatches) {
		for (const r of src.results) {
			if (pepKeywords.some(k => (r.snippet || '').toLowerCase().includes(k))) {
				score += 10;
				break;
			}
		}
	}

	return Math.min(score, 100);
}

// ─── Get existing reports ─────────────────────────────────────────────────────

export async function getUserReports(userId: string) {
	return (prisma as any).intelligenceReport.findMany({
		where: {
			userId,
			expiresAt: { gte: new Date() },
		},
		orderBy: { createdAt: 'desc' },
		take: 50,
	});
}

export async function getReport(reportId: string, userId: string) {
	return (prisma as any).intelligenceReport.findFirst({
		where: { id: reportId, userId }
	});
}
