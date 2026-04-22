/**
 * Batch Search Service — Recherche en Lot
 *
 * Traitement de fichiers CSV/JSON contenant plusieurs entités à vérifier:
 *   - Upload CSV (nom, prénom, date_naissance, nationalite, ...)
 *   - Vérification parallèle avec throttling (respecter les APIs)
 *   - Résultats agrégés par entité
 *   - Export CSV/JSON des résultats
 *   - Progression en temps réel
 *   - Résumé statistique
 */

import prisma from '../lib/prisma';
import { runOsintQuick, OsintQuery } from './osintMegaService';
import { computeFuzzyMatch } from './fuzzyMatchService';
import { logSystemEvent } from '../utils/logger';

export interface BatchRecord {
	rowIndex: number;
	nom: string;
	prenom?: string;
	dateNaissance?: string;
	nationalite?: string;
	pays?: string;
	entreprise?: string;
	siret?: string;
	reference?: string;  // user-provided reference
	notes?: string;
}

export interface BatchSearchOptions {
	records: BatchRecord[];
	searchTypes: ('PPE' | 'SANCTIONS' | 'GEL_AVOIRS' | 'INTERPOL' | 'PAYS_RISQUE' | 'PRESSE' | 'ENTREPRISE')[];
	confidenceThreshold?: number;
	concurrency?: number;
	name?: string;
	userId: string;
}

export interface BatchRecordResult {
	rowIndex: number;
	nom: string;
	prenom?: string;
	reference?: string;
	hasHit: boolean;
	riskLevel: 'AUCUN' | 'FAIBLE' | 'MOYEN' | 'ELEVE' | 'CRITIQUE';
	sanctionsHit: boolean;
	gelAvoirsHit: boolean;
	pepHit: boolean;
	interpolHit: boolean;
	paysRisqueHit: boolean;
	presseHit: boolean;
	matchCount: number;
	maxConfidence: number;
	topMatches: Array<{ source: string; name: string; score: number; severity: string; snippet?: string }>;
	durationMs: number;
	error?: string;
}

export interface BatchSearchResult {
	batchId: string;
	name: string;
	status: string;
	totalRecords: number;
	processedCount: number;
	hitCount: number;
	criticalCount: number;
	highCount: number;
	results: BatchRecordResult[];
	summary: BatchSummary;
	createdAt: Date;
	completedAt?: Date;
}

export interface BatchSummary {
	totalProcessed: number;
	totalHits: number;
	hitRate: string;
	criticalCount: number;
	highCount: number;
	mediumCount: number;
	byType: Record<string, number>;
	averageDurationMs: number;
	topRiskEntities: BatchRecordResult[];
}

// ─── Parse CSV to records ─────────────────────────────────────────────────────

export function parseCSVToRecords(csvContent: string): BatchRecord[] {
	const lines = csvContent.split('\n').filter(l => l.trim());
	if (lines.length < 2) return [];

	const headers = lines[0].split(/[,;|\t]/).map(h =>
		h.trim().toLowerCase()
			.replace(/é|è|ê/g, 'e')
			.replace(/à|â/g, 'a')
			.replace(/ô/g, 'o')
			.replace(/\s+/g, '_')
	);

	const records: BatchRecord[] = [];

	for (let i = 1; i < lines.length; i++) {
		const values = lines[i].split(/[,;|\t]/).map(v => v.trim().replace(/^["']|["']$/g, ''));
		if (values.every(v => !v)) continue;

		const row: any = {};
		headers.forEach((h, idx) => {
			row[h] = values[idx] || '';
		});

		const record: BatchRecord = {
			rowIndex: i,
			nom:           row['nom'] || row['name'] || row['last_name'] || row['lastName'] || '',
			prenom:        row['prenom'] || row['first_name'] || row['firstName'] || row['prenom_usuel'] || undefined,
			dateNaissance: row['date_naissance'] || row['dob'] || row['birthdate'] || undefined,
			nationalite:   row['nationalite'] || row['nationality'] || undefined,
			pays:          row['pays'] || row['country'] || undefined,
			entreprise:    row['entreprise'] || row['company'] || row['societe'] || undefined,
			siret:         row['siret'] || row['siren'] || undefined,
			reference:     row['reference'] || row['ref'] || row['id'] || undefined,
			notes:         row['notes'] || row['commentaire'] || undefined,
		};

		if (record.nom) records.push(record);
	}

	return records;
}

// ─── Process single record ────────────────────────────────────────────────────

async function processRecord(
	record: BatchRecord,
	searchTypes: BatchSearchOptions['searchTypes'],
	threshold: number
): Promise<BatchRecordResult> {
	const start = Date.now();
	const result: BatchRecordResult = {
		rowIndex: record.rowIndex,
		nom: record.nom,
		prenom: record.prenom,
		reference: record.reference,
		hasHit: false,
		riskLevel: 'AUCUN',
		sanctionsHit: false,
		gelAvoirsHit: false,
		pepHit: false,
		interpolHit: false,
		paysRisqueHit: false,
		presseHit: false,
		matchCount: 0,
		maxConfidence: 0,
		topMatches: [],
		durationMs: 0,
	};

	try {
		const query: OsintQuery = {
			nom: record.nom,
			prenom: record.prenom,
			dateNaissance: record.dateNaissance,
			nationalite: record.nationalite,
			pays: record.pays,
			entreprise: record.entreprise,
			siret: record.siret,
			type: record.prenom ? 'PERSON' : (record.entreprise ? 'COMPANY' : 'PERSON'),
			confidenceThreshold: threshold,
		};

		const report = await runOsintQuick(query);
		const allMatches = report.sources.flatMap(s => s.results);

		result.matchCount = allMatches.length;
		result.maxConfidence = allMatches.length > 0 ? Math.max(...allMatches.map(m => m.matchScore)) : 0;
		result.hasHit = allMatches.length > 0;
		result.riskLevel = report.overallRisk === 'AUCUN' ? 'AUCUN' :
			report.overallRisk as any;

		// Type-specific hits
		for (const src of report.sources) {
			if (src.matchCount === 0) continue;
			if (src.category === 'SANCTIONS') result.sanctionsHit = true;
			if (src.category === 'GEL_AVOIRS') result.gelAvoirsHit = true;
			if (src.category === 'INTERPOL') result.interpolHit = true;
			if (src.category === 'RISQUE_PAYS') result.paysRisqueHit = true;
			if (src.category === 'PRESSE') result.presseHit = true;
		}

		// Check Wikipedia for PPE
		const wikiSrc = report.sources.find(s => s.id === 'wikipedia');
		if (wikiSrc?.results.some(r => (r.details as any)?.isPEP)) result.pepHit = true;

		// Top matches (sorted by confidence)
		result.topMatches = allMatches
			.sort((a, b) => b.matchScore - a.matchScore)
			.slice(0, 5)
			.map(m => ({
				source: m.sourceId,
				name: m.name,
				score: m.matchScore,
				severity: m.severity,
				snippet: m.snippet?.substring(0, 100),
			}));

	} catch (e) {
		result.error = e instanceof Error ? e.message : String(e);
	}

	result.durationMs = Date.now() - start;
	return result;
}

// ─── Run batch search ─────────────────────────────────────────────────────────

export async function runBatchSearch(opts: BatchSearchOptions): Promise<BatchSearchResult> {
	const start = Date.now();
	const batchName = opts.name || `Lot ${new Date().toISOString().substring(0, 10)}`;
	const threshold = opts.confidenceThreshold || 0.72;
	const concurrency = Math.min(opts.concurrency || 3, 5); // max 5 concurrent to avoid rate limiting

	logSystemEvent({
		action: 'batch_search_start',
		component: 'batchSearchService',
		details: { batchName, recordCount: opts.records.length, types: opts.searchTypes },
		severity: 'info',
	});

	// Create DB record
	const batch = await (prisma as any).batchSearch.create({
		data: {
			userId: opts.userId,
			name: batchName,
			searchTypes: opts.searchTypes,
			totalRecords: opts.records.length,
			status: 'RUNNING',
			inputData: opts.records as any[],
		}
	});

	const results: BatchRecordResult[] = [];
	const chunks: BatchRecord[][] = [];

	// Split into chunks for controlled concurrency
	for (let i = 0; i < opts.records.length; i += concurrency) {
		chunks.push(opts.records.slice(i, i + concurrency));
	}

	for (const chunk of chunks) {
		const chunkResults = await Promise.all(
			chunk.map(record => processRecord(record, opts.searchTypes, threshold))
		);
		results.push(...chunkResults);

		// Save progress
		await (prisma as any).batchSearch.update({
			where: { id: batch.id },
			data: { processedCount: results.length }
		});

		// Save results to DB
		for (const r of chunkResults) {
			await (prisma as any).batchSearchResult.create({
				data: {
					batchId: batch.id,
					rowIndex: r.rowIndex,
					inputData: { nom: r.nom, prenom: r.prenom, reference: r.reference } as any,
					hasHit: r.hasHit,
					riskLevel: r.riskLevel,
					matches: r.topMatches as any[],
					sources: r.topMatches.map(m => m.source),
					confidence: r.maxConfidence,
				}
			});
		}

		// Throttle between chunks
		if (chunks.indexOf(chunk) < chunks.length - 1) {
			await new Promise(r => setTimeout(r, 1500));
		}
	}

	// Build summary
	const summary = buildBatchSummary(results);

	// Update DB
	await (prisma as any).batchSearch.update({
		where: { id: batch.id },
		data: {
			status: 'COMPLETED',
			processedCount: results.length,
			hitCount: summary.totalHits,
			completedAt: new Date(),
		}
	});

	logSystemEvent({
		action: 'batch_search_complete',
		component: 'batchSearchService',
		details: {
			batchId: batch.id,
			records: results.length,
			hits: summary.totalHits,
			durationMs: Date.now() - start,
		},
		severity: 'info',
	});

	return {
		batchId: batch.id,
		name: batchName,
		status: 'COMPLETED',
		totalRecords: opts.records.length,
		processedCount: results.length,
		hitCount: summary.totalHits,
		criticalCount: summary.criticalCount,
		highCount: summary.highCount,
		results,
		summary,
		createdAt: batch.createdAt,
		completedAt: new Date(),
	};
}

// ─── Build summary ────────────────────────────────────────────────────────────

function buildBatchSummary(results: BatchRecordResult[]): BatchSummary {
	const hits = results.filter(r => r.hasHit);
	const criticals = results.filter(r => r.riskLevel === 'CRITIQUE');
	const highs     = results.filter(r => r.riskLevel === 'ELEVE');
	const mediums   = results.filter(r => r.riskLevel === 'MOYEN');

	const byType: Record<string, number> = {
		SANCTIONS:   results.filter(r => r.sanctionsHit).length,
		GEL_AVOIRS:  results.filter(r => r.gelAvoirsHit).length,
		PPE:         results.filter(r => r.pepHit).length,
		INTERPOL:    results.filter(r => r.interpolHit).length,
		PAYS_RISQUE: results.filter(r => r.paysRisqueHit).length,
		PRESSE:      results.filter(r => r.presseHit).length,
	};

	const avgDuration = results.length > 0
		? results.reduce((sum, r) => sum + r.durationMs, 0) / results.length
		: 0;

	return {
		totalProcessed: results.length,
		totalHits: hits.length,
		hitRate: results.length > 0 ? `${((hits.length / results.length) * 100).toFixed(1)}%` : '0%',
		criticalCount: criticals.length,
		highCount: highs.length,
		mediumCount: mediums.length,
		byType,
		averageDurationMs: Math.round(avgDuration),
		topRiskEntities: [...criticals, ...highs].slice(0, 10),
	};
}

// ─── Export to CSV ────────────────────────────────────────────────────────────

export function exportBatchResultsToCSV(results: BatchRecordResult[]): string {
	const headers = [
		'Ligne', 'Nom', 'Prénom', 'Référence',
		'Alerte', 'Niveau de Risque',
		'Sanctions', 'Gel des Avoirs', 'PPE', 'Interpol', 'Pays Risque', 'Presse',
		'Nb Correspondances', 'Confiance Max',
		'Top Correspondance Source', 'Top Correspondance Nom', 'Top Correspondance Score',
		'Erreur'
	].join(';');

	const rows = results.map(r => [
		r.rowIndex,
		r.nom,
		r.prenom || '',
		r.reference || '',
		r.hasHit ? 'OUI' : 'NON',
		r.riskLevel,
		r.sanctionsHit ? 'OUI' : 'NON',
		r.gelAvoirsHit ? 'OUI' : 'NON',
		r.pepHit ? 'OUI' : 'NON',
		r.interpolHit ? 'OUI' : 'NON',
		r.paysRisqueHit ? 'OUI' : 'NON',
		r.presseHit ? 'OUI' : 'NON',
		r.matchCount,
		(r.maxConfidence * 100).toFixed(0) + '%',
		r.topMatches[0]?.source || '',
		r.topMatches[0]?.name || '',
		r.topMatches[0]?.score ? (r.topMatches[0].score * 100).toFixed(0) + '%' : '',
		r.error || '',
	].join(';'));

	return [headers, ...rows].join('\n');
}

// ─── Get batch status ─────────────────────────────────────────────────────────

export async function getBatchSearch(batchId: string, userId: string) {
	return (prisma as any).batchSearch.findFirst({
		where: { id: batchId, userId },
		include: {
			results: {
				orderBy: [{ hasHit: 'desc' }, { rowIndex: 'asc' }],
				take: 500,
			}
		}
	});
}

export async function getUserBatchSearches(userId: string) {
	return (prisma as any).batchSearch.findMany({
		where: { userId },
		orderBy: { createdAt: 'desc' },
		take: 20,
		select: {
			id: true,
			name: true,
			status: true,
			totalRecords: true,
			processedCount: true,
			hitCount: true,
			searchTypes: true,
			createdAt: true,
			completedAt: true,
		}
	});
}
