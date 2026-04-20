/**
 * Search Routes — /api/search
 *
 *  GET  /api/search?q=...&types=...&page=...           Universal search
 *  POST /api/search/advanced                           Advanced multi-filter search
 *  GET  /api/search/suggestions?q=...                 Autocomplete suggestions
 *  GET  /api/search/history                           User search history
 *  DELETE /api/search/history/:id                     Delete history entry
 *  POST /api/search/saved                             Save a search
 *  GET  /api/search/saved                             List saved searches
 *  PUT  /api/search/saved/:id                         Update saved search
 *  DELETE /api/search/saved/:id                       Delete saved search
 *  POST /api/search/saved/:id/run                     Re-run a saved search
 *  GET  /api/search/export?batchId=...                Export results as CSV
 *  POST /api/search/batch                             Start batch search
 *  GET  /api/search/batch                             List user batch searches
 *  GET  /api/search/batch/:id                         Get batch results
 *  GET  /api/search/batch/:id/export                  Export batch CSV
 *  POST /api/search/batch/:id/cancel                  Cancel batch search
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, ValidationError } from '../../middleware/errorHandler';
import { authenticateToken, AuthenticatedRequest } from '../../middleware/auth';
import {
	universalSearch,
	generateSuggestions,
	recordSearchHistory,
	type AdvancedFilters,
} from '../../services/universalSearchService';
import {
	runBatchSearch,
	parseCSVToRecords,
	exportBatchResultsToCSV,
	getBatchSearch,
	getUserBatchSearches,
	type BatchSearchOptions,
} from '../../services/batchSearchService';
import prisma from '../../lib/prisma';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const auth = authenticateToken as any;

// ─── Schemas ────────────────────────────────────────────────────────────────

const universalSearchSchema = z.object({
	q:           z.string().min(1).max(200),
	types:       z.string().optional(),
	page:        z.coerce.number().min(1).default(1),
	limit:       z.coerce.number().min(1).max(100).default(20),
	sortBy:      z.enum(['relevance', 'date', 'risk']).default('relevance'),
	sortOrder:   z.enum(['asc', 'desc']).default('desc'),
	dateFrom:    z.string().optional(),
	dateTo:      z.string().optional(),
});

const advancedSearchSchema = z.object({
	query: z.string().optional().default(''),
	entityTypes: z.array(z.string()).optional(),
	page:  z.number().min(1).default(1),
	limit: z.number().min(1).max(100).default(20),
	sortBy: z.enum(['relevance', 'date', 'risk']).default('relevance'),
	filters: z.object({
		// Temporal
		dateFrom:   z.string().optional(),
		dateTo:     z.string().optional(),
		// Clients
		nationalite: z.array(z.string()).optional(),
		profession:  z.array(z.string()).optional(),
		personnePublique: z.boolean().optional(),
		revenus: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
		patrimoine: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
		pays: z.array(z.string()).optional(),
		ville: z.string().optional(),
		// Dossiers
		dossierStatus:  z.array(z.string()).optional(),
		typeOuverture:  z.array(z.string()).optional(),
		montant: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
		assignedToId:   z.string().optional(),
		createdById:    z.string().optional(),
		// Risque
		scoringNiveau:  z.array(z.string()).optional(),
		scoreRange: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
		// Exceptions
		exceptionType:     z.array(z.string()).optional(),
		exceptionStatus:   z.array(z.string()).optional(),
		exceptionPriority: z.array(z.string()).optional(),
		// Documents
		documentType:     z.array(z.string()).optional(),
		documentVerified: z.boolean().optional(),
		hasOcrText:       z.boolean().optional(),
		// Recherches
		rechercheType:   z.array(z.string()).optional(),
		rechercheStatus: z.array(z.string()).optional(),
		confidenceMin:   z.number().min(0).max(1).optional(),
		// TRACFIN
		tracfinStatus: z.array(z.string()).optional(),
		risqueLevel:   z.array(z.string()).optional(),
		// Audit
		auditAction:   z.array(z.string()).optional(),
		auditResource: z.string().optional(),
		ipAddress:     z.string().optional(),
	}).optional().default({}),
});

const savedSearchSchema = z.object({
	name:          z.string().min(1).max(100),
	description:   z.string().max(500).optional(),
	queryParams:   z.any(),
	searchType:    z.string().default('UNIVERSAL'),
	isAlertEnabled: z.boolean().default(false),
	alertFrequency: z.enum(['REALTIME', 'DAILY', 'WEEKLY', 'MONTHLY']).optional(),
	alertThreshold: z.number().min(0).max(1).optional(),
});

const batchSearchSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	searchTypes: z.array(z.enum(['PPE', 'SANCTIONS', 'GEL_AVOIRS', 'INTERPOL', 'PAYS_RISQUE', 'PRESSE', 'ENTREPRISE']))
		.default(['PPE', 'SANCTIONS', 'GEL_AVOIRS', 'INTERPOL', 'PAYS_RISQUE']),
	confidenceThreshold: z.number().min(0).max(1).default(0.72),
	concurrency: z.number().min(1).max(5).default(3),
	records: z.array(z.object({
		rowIndex:      z.number(),
		nom:           z.string().min(1),
		prenom:        z.string().optional(),
		dateNaissance: z.string().optional(),
		nationalite:   z.string().optional(),
		pays:          z.string().optional(),
		entreprise:    z.string().optional(),
		siret:         z.string().optional(),
		reference:     z.string().optional(),
	})).optional(),
});

// ─── GET /api/search — Universal search ─────────────────────────────────────

router.get('/', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const params = universalSearchSchema.parse(req.query);
	const entityTypes = params.types
		? (params.types.split(',').map(t => t.trim().toUpperCase()) as any[])
		: undefined;

	const result = await universalSearch({
		query: params.q,
		entityTypes,
		page: params.page,
		limit: params.limit,
		sortBy: params.sortBy,
		sortOrder: params.sortOrder,
		filters: {
			dateFrom: params.dateFrom,
			dateTo:   params.dateTo,
		},
		userId:   req.user!.id,
		userRole: req.user!.role,
	});

	// Record history (non-blocking)
	recordSearchHistory(req.user!.id, params.q, params, result);

	res.json({ success: true, data: result });
}));

// ─── POST /api/search/advanced — Advanced search ─────────────────────────────

router.post('/advanced', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const params = advancedSearchSchema.parse(req.body);

	const result = await universalSearch({
		query:       params.query || '',
		entityTypes: params.entityTypes as any[],
		page:        params.page,
		limit:       params.limit,
		sortBy:      params.sortBy,
		filters:     params.filters as AdvancedFilters,
		userId:      req.user!.id,
		userRole:    req.user!.role,
	});

	if (params.query) {
		recordSearchHistory(req.user!.id, params.query, params, result);
	}

	res.json({ success: true, data: result });
}));

// ─── GET /api/search/suggestions — Autocomplete ──────────────────────────────

router.get('/suggestions', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const q = z.string().min(1).max(100).parse(req.query.q);
	const suggestions = await generateSuggestions(q);
	res.json({ success: true, data: { suggestions } });
}));

// ─── GET /api/search/history — Search history ────────────────────────────────

router.get('/history', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 200);

	const history = await (prisma as any).searchHistory.findMany({
		where: { userId: req.user!.id },
		orderBy: { createdAt: 'desc' },
		take: limit,
	});

	res.json({ success: true, data: { history } });
}));

// ─── DELETE /api/search/history/:id ─────────────────────────────────────────

router.delete('/history/:id', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	if (req.params.id === 'all') {
		await (prisma as any).searchHistory.deleteMany({ where: { userId: req.user!.id } });
	} else {
		await (prisma as any).searchHistory.deleteMany({
			where: { id: req.params.id, userId: req.user!.id }
		});
	}
	res.json({ success: true });
}));

// ─── POST /api/search/saved — Save a search ──────────────────────────────────

router.post('/saved', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const data = savedSearchSchema.parse(req.body);

	const saved = await (prisma as any).savedSearch.create({
		data: { ...data, userId: req.user!.id }
	});

	res.status(201).json({ success: true, data: { savedSearch: saved } });
}));

// ─── GET /api/search/saved — List saved searches ─────────────────────────────

router.get('/saved', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const saved = await (prisma as any).savedSearch.findMany({
		where: { userId: req.user!.id },
		orderBy: { updatedAt: 'desc' },
	});
	res.json({ success: true, data: { savedSearches: saved } });
}));

// ─── PUT /api/search/saved/:id — Update saved search ─────────────────────────

router.put('/saved/:id', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const data = savedSearchSchema.partial().parse(req.body);

	const existing = await (prisma as any).savedSearch.findFirst({
		where: { id: req.params.id, userId: req.user!.id }
	});
	if (!existing) throw new ValidationError('Recherche sauvegardée introuvable');

	const updated = await (prisma as any).savedSearch.update({
		where: { id: req.params.id },
		data,
	});

	res.json({ success: true, data: { savedSearch: updated } });
}));

// ─── DELETE /api/search/saved/:id ────────────────────────────────────────────

router.delete('/saved/:id', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	await (prisma as any).savedSearch.deleteMany({
		where: { id: req.params.id, userId: req.user!.id }
	});
	res.json({ success: true });
}));

// ─── POST /api/search/saved/:id/run — Re-run saved search ────────────────────

router.post('/saved/:id/run', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const saved = await (prisma as any).savedSearch.findFirst({
		where: { id: req.params.id, userId: req.user!.id }
	});
	if (!saved) throw new ValidationError('Recherche sauvegardée introuvable');

	const params = saved.queryParams as any;
	const result = await universalSearch({
		query:       params.query || params.q || '',
		entityTypes: params.entityTypes || params.types?.split(','),
		page:        1,
		limit:       params.limit || 20,
		sortBy:      params.sortBy || 'relevance',
		filters:     params.filters || {},
		userId:      req.user!.id,
		userRole:    req.user!.role,
	});

	// Update lastRun
	await (prisma as any).savedSearch.update({
		where: { id: saved.id },
		data: { lastRunAt: new Date(), lastResultCount: result.total }
	});

	recordSearchHistory(req.user!.id, params.query || params.q || '', params, result);

	res.json({ success: true, data: result });
}));

// ─── POST /api/search/batch — Start batch search (JSON records) ──────────────

router.post('/batch', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const params = batchSearchSchema.parse(req.body);

	if (!params.records || params.records.length === 0) {
		throw new ValidationError('Aucun enregistrement fourni');
	}
	if (params.records.length > 1000) {
		throw new ValidationError('Maximum 1000 enregistrements par lot');
	}

	const opts: BatchSearchOptions = {
		records: params.records,
		searchTypes: params.searchTypes,
		confidenceThreshold: params.confidenceThreshold,
		concurrency: params.concurrency,
		name: params.name,
		userId: req.user!.id,
	};

	// Start in background, return immediately
	const batchPromise = runBatchSearch(opts);

	// Return immediately with batchId (we'll look it up later)
	// Actually run synchronously for now to keep it simple
	const result = await batchPromise;

	res.json({ success: true, data: result });
}));

// ─── POST /api/search/batch/upload — Upload CSV ──────────────────────────────

router.post('/batch/upload', auth, upload.single('file'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	if (!req.file) throw new ValidationError('Fichier CSV requis');

	const csvContent = req.file.buffer.toString('utf-8');
	const records = parseCSVToRecords(csvContent);

	if (records.length === 0) {
		throw new ValidationError('Aucun enregistrement valide dans le fichier CSV. Vérifiez les en-têtes (nom, prenom, date_naissance, nationalite...)');
	}
	if (records.length > 1000) {
		throw new ValidationError('Maximum 1000 lignes par fichier');
	}

	const searchTypes = req.body.searchTypes
		? JSON.parse(req.body.searchTypes)
		: ['PPE', 'SANCTIONS', 'GEL_AVOIRS', 'INTERPOL', 'PAYS_RISQUE'];

	const opts: BatchSearchOptions = {
		records,
		searchTypes,
		confidenceThreshold: parseFloat(req.body.confidenceThreshold || '0.72'),
		concurrency: parseInt(req.body.concurrency || '3', 10),
		name: req.body.name || req.file.originalname,
		userId: req.user!.id,
	};

	const result = await runBatchSearch(opts);
	res.json({ success: true, data: result });
}));

// ─── GET /api/search/batch — List user batch searches ────────────────────────

router.get('/batch', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const searches = await getUserBatchSearches(req.user!.id);
	res.json({ success: true, data: { searches } });
}));

// ─── GET /api/search/batch/:id — Get batch results ───────────────────────────

router.get('/batch/:id', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const batch = await getBatchSearch(req.params.id, req.user!.id);
	if (!batch) throw new ValidationError('Lot de recherche introuvable');
	res.json({ success: true, data: { batch } });
}));

// ─── GET /api/search/batch/:id/export — Export CSV ───────────────────────────

router.get('/batch/:id/export', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const batch = await getBatchSearch(req.params.id, req.user!.id);
	if (!batch) throw new ValidationError('Lot de recherche introuvable');

	const mappedResults = (batch.results || []).map((r: any) => ({
		rowIndex: r.rowIndex,
		nom: (r.inputData as any)?.nom || '',
		prenom: (r.inputData as any)?.prenom || '',
		reference: (r.inputData as any)?.reference || '',
		hasHit: r.hasHit,
		riskLevel: r.riskLevel || 'AUCUN',
		sanctionsHit: (r.sources || []).includes('open_sanctions') || (r.sources || []).includes('ofac_sdn'),
		gelAvoirsHit: (r.sources || []).includes('dgtresor_gel'),
		pepHit: (r.sources || []).includes('wikipedia'),
		interpolHit: (r.sources || []).includes('interpol'),
		paysRisqueHit: (r.sources || []).includes('fatf') || (r.sources || []).includes('transparency_intl'),
		presseHit: (r.sources || []).includes('google_news'),
		matchCount: (r.matches || []).length,
		maxConfidence: r.confidence || 0,
		topMatches: r.matches || [],
		durationMs: 0,
	}));

	const csv = exportBatchResultsToCSV(mappedResults);
	const filename = `batch-${batch.id}-${new Date().toISOString().substring(0, 10)}.csv`;

	res.setHeader('Content-Type', 'text/csv; charset=utf-8');
	res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
	res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compatibility
}));

// ─── GET /api/search/stats — Global search stats ─────────────────────────────

router.get('/stats', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const userId = req.user!.id;

	const [
		totalSearches,
		totalSaved,
		totalBatches,
		recentSearches,
	] = await Promise.all([
		(prisma as any).searchHistory.count({ where: { userId } }),
		(prisma as any).savedSearch.count({ where: { userId } }),
		(prisma as any).batchSearch.count({ where: { userId } }),
		(prisma as any).searchHistory.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			take: 10,
			select: { query: true, resultsCount: true, createdAt: true, entityTypes: true },
		}),
	]);

	res.json({
		success: true,
		data: {
			totalSearches,
			totalSaved,
			totalBatches,
			recentSearches,
		}
	});
}));

export default router;
