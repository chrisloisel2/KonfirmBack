"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const universalSearchService_1 = require("../../services/universalSearchService");
const batchSearchService_1 = require("../../services/batchSearchService");
const prisma_1 = __importDefault(require("../../lib/prisma"));
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const auth = auth_1.authenticateToken;
// ─── Schemas ────────────────────────────────────────────────────────────────
const universalSearchSchema = zod_1.z.object({
    q: zod_1.z.string().min(1).max(200),
    types: zod_1.z.string().optional(),
    page: zod_1.z.coerce.number().min(1).default(1),
    limit: zod_1.z.coerce.number().min(1).max(100).default(20),
    sortBy: zod_1.z.enum(['relevance', 'date', 'risk']).default('relevance'),
    sortOrder: zod_1.z.enum(['asc', 'desc']).default('desc'),
    dateFrom: zod_1.z.string().optional(),
    dateTo: zod_1.z.string().optional(),
});
const advancedSearchSchema = zod_1.z.object({
    query: zod_1.z.string().optional().default(''),
    entityTypes: zod_1.z.array(zod_1.z.string()).optional(),
    page: zod_1.z.number().min(1).default(1),
    limit: zod_1.z.number().min(1).max(100).default(20),
    sortBy: zod_1.z.enum(['relevance', 'date', 'risk']).default('relevance'),
    filters: zod_1.z.object({
        // Temporal
        dateFrom: zod_1.z.string().optional(),
        dateTo: zod_1.z.string().optional(),
        // Clients
        nationalite: zod_1.z.array(zod_1.z.string()).optional(),
        profession: zod_1.z.array(zod_1.z.string()).optional(),
        personnePublique: zod_1.z.boolean().optional(),
        revenus: zod_1.z.object({ min: zod_1.z.number().optional(), max: zod_1.z.number().optional() }).optional(),
        patrimoine: zod_1.z.object({ min: zod_1.z.number().optional(), max: zod_1.z.number().optional() }).optional(),
        pays: zod_1.z.array(zod_1.z.string()).optional(),
        ville: zod_1.z.string().optional(),
        // Dossiers
        dossierStatus: zod_1.z.array(zod_1.z.string()).optional(),
        typeOuverture: zod_1.z.array(zod_1.z.string()).optional(),
        montant: zod_1.z.object({ min: zod_1.z.number().optional(), max: zod_1.z.number().optional() }).optional(),
        assignedToId: zod_1.z.string().optional(),
        createdById: zod_1.z.string().optional(),
        // Risque
        scoringNiveau: zod_1.z.array(zod_1.z.string()).optional(),
        scoreRange: zod_1.z.object({ min: zod_1.z.number().optional(), max: zod_1.z.number().optional() }).optional(),
        // Exceptions
        exceptionType: zod_1.z.array(zod_1.z.string()).optional(),
        exceptionStatus: zod_1.z.array(zod_1.z.string()).optional(),
        exceptionPriority: zod_1.z.array(zod_1.z.string()).optional(),
        // Documents
        documentType: zod_1.z.array(zod_1.z.string()).optional(),
        documentVerified: zod_1.z.boolean().optional(),
        hasOcrText: zod_1.z.boolean().optional(),
        // Recherches
        rechercheType: zod_1.z.array(zod_1.z.string()).optional(),
        rechercheStatus: zod_1.z.array(zod_1.z.string()).optional(),
        confidenceMin: zod_1.z.number().min(0).max(1).optional(),
        // TRACFIN
        tracfinStatus: zod_1.z.array(zod_1.z.string()).optional(),
        risqueLevel: zod_1.z.array(zod_1.z.string()).optional(),
        // Audit
        auditAction: zod_1.z.array(zod_1.z.string()).optional(),
        auditResource: zod_1.z.string().optional(),
        ipAddress: zod_1.z.string().optional(),
    }).optional().default({}),
});
const savedSearchSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    description: zod_1.z.string().max(500).optional(),
    queryParams: zod_1.z.any(),
    searchType: zod_1.z.string().default('UNIVERSAL'),
    isAlertEnabled: zod_1.z.boolean().default(false),
    alertFrequency: zod_1.z.enum(['REALTIME', 'DAILY', 'WEEKLY', 'MONTHLY']).optional(),
    alertThreshold: zod_1.z.number().min(0).max(1).optional(),
});
const batchSearchSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200).optional(),
    searchTypes: zod_1.z.array(zod_1.z.enum(['PPE', 'SANCTIONS', 'GEL_AVOIRS', 'INTERPOL', 'PAYS_RISQUE', 'PRESSE', 'ENTREPRISE']))
        .default(['PPE', 'SANCTIONS', 'GEL_AVOIRS', 'INTERPOL', 'PAYS_RISQUE']),
    confidenceThreshold: zod_1.z.number().min(0).max(1).default(0.72),
    concurrency: zod_1.z.number().min(1).max(5).default(3),
    records: zod_1.z.array(zod_1.z.object({
        rowIndex: zod_1.z.number(),
        nom: zod_1.z.string().min(1),
        prenom: zod_1.z.string().optional(),
        dateNaissance: zod_1.z.string().optional(),
        nationalite: zod_1.z.string().optional(),
        pays: zod_1.z.string().optional(),
        entreprise: zod_1.z.string().optional(),
        siret: zod_1.z.string().optional(),
        reference: zod_1.z.string().optional(),
    })).optional(),
});
// ─── GET /api/search — Universal search ─────────────────────────────────────
router.get('/', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const params = universalSearchSchema.parse(req.query);
    const entityTypes = params.types
        ? params.types.split(',').map(t => t.trim().toUpperCase())
        : undefined;
    const result = await (0, universalSearchService_1.universalSearch)({
        query: params.q,
        entityTypes,
        page: params.page,
        limit: params.limit,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
        filters: {
            dateFrom: params.dateFrom,
            dateTo: params.dateTo,
        },
        userId: req.user.id,
        userRole: req.user.role,
    });
    // Record history (non-blocking)
    (0, universalSearchService_1.recordSearchHistory)(req.user.id, params.q, params, result);
    res.json({ success: true, data: result });
}));
// ─── POST /api/search/advanced — Advanced search ─────────────────────────────
router.post('/advanced', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const params = advancedSearchSchema.parse(req.body);
    const result = await (0, universalSearchService_1.universalSearch)({
        query: params.query || '',
        entityTypes: params.entityTypes,
        page: params.page,
        limit: params.limit,
        sortBy: params.sortBy,
        filters: params.filters,
        userId: req.user.id,
        userRole: req.user.role,
    });
    if (params.query) {
        (0, universalSearchService_1.recordSearchHistory)(req.user.id, params.query, params, result);
    }
    res.json({ success: true, data: result });
}));
// ─── GET /api/search/suggestions — Autocomplete ──────────────────────────────
router.get('/suggestions', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const q = zod_1.z.string().min(1).max(100).parse(req.query.q);
    const suggestions = await (0, universalSearchService_1.generateSuggestions)(q);
    res.json({ success: true, data: { suggestions } });
}));
// ─── GET /api/search/history — Search history ────────────────────────────────
router.get('/history', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const history = await prisma_1.default.searchHistory.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
    });
    res.json({ success: true, data: { history } });
}));
// ─── DELETE /api/search/history/:id ─────────────────────────────────────────
router.delete('/history/:id', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    if (req.params.id === 'all') {
        await prisma_1.default.searchHistory.deleteMany({ where: { userId: req.user.id } });
    }
    else {
        await prisma_1.default.searchHistory.deleteMany({
            where: { id: req.params.id, userId: req.user.id }
        });
    }
    res.json({ success: true });
}));
// ─── POST /api/search/saved — Save a search ──────────────────────────────────
router.post('/saved', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = savedSearchSchema.parse(req.body);
    const saved = await prisma_1.default.savedSearch.create({
        data: { ...data, userId: req.user.id }
    });
    res.status(201).json({ success: true, data: { savedSearch: saved } });
}));
// ─── GET /api/search/saved — List saved searches ─────────────────────────────
router.get('/saved', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const saved = await prisma_1.default.savedSearch.findMany({
        where: { userId: req.user.id },
        orderBy: { updatedAt: 'desc' },
    });
    res.json({ success: true, data: { savedSearches: saved } });
}));
// ─── PUT /api/search/saved/:id — Update saved search ─────────────────────────
router.put('/saved/:id', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = savedSearchSchema.partial().parse(req.body);
    const existing = await prisma_1.default.savedSearch.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    if (!existing)
        throw new errorHandler_1.ValidationError('Recherche sauvegardée introuvable');
    const updated = await prisma_1.default.savedSearch.update({
        where: { id: req.params.id },
        data,
    });
    res.json({ success: true, data: { savedSearch: updated } });
}));
// ─── DELETE /api/search/saved/:id ────────────────────────────────────────────
router.delete('/saved/:id', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    await prisma_1.default.savedSearch.deleteMany({
        where: { id: req.params.id, userId: req.user.id }
    });
    res.json({ success: true });
}));
// ─── POST /api/search/saved/:id/run — Re-run saved search ────────────────────
router.post('/saved/:id/run', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const saved = await prisma_1.default.savedSearch.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    if (!saved)
        throw new errorHandler_1.ValidationError('Recherche sauvegardée introuvable');
    const params = saved.queryParams;
    const result = await (0, universalSearchService_1.universalSearch)({
        query: params.query || params.q || '',
        entityTypes: params.entityTypes || params.types?.split(','),
        page: 1,
        limit: params.limit || 20,
        sortBy: params.sortBy || 'relevance',
        filters: params.filters || {},
        userId: req.user.id,
        userRole: req.user.role,
    });
    // Update lastRun
    await prisma_1.default.savedSearch.update({
        where: { id: saved.id },
        data: { lastRunAt: new Date(), lastResultCount: result.total }
    });
    (0, universalSearchService_1.recordSearchHistory)(req.user.id, params.query || params.q || '', params, result);
    res.json({ success: true, data: result });
}));
// ─── POST /api/search/batch — Start batch search (JSON records) ──────────────
router.post('/batch', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const params = batchSearchSchema.parse(req.body);
    if (!params.records || params.records.length === 0) {
        throw new errorHandler_1.ValidationError('Aucun enregistrement fourni');
    }
    if (params.records.length > 1000) {
        throw new errorHandler_1.ValidationError('Maximum 1000 enregistrements par lot');
    }
    const opts = {
        records: params.records,
        searchTypes: params.searchTypes,
        confidenceThreshold: params.confidenceThreshold,
        concurrency: params.concurrency,
        name: params.name,
        userId: req.user.id,
    };
    // Start in background, return immediately
    const batchPromise = (0, batchSearchService_1.runBatchSearch)(opts);
    // Return immediately with batchId (we'll look it up later)
    // Actually run synchronously for now to keep it simple
    const result = await batchPromise;
    res.json({ success: true, data: result });
}));
// ─── POST /api/search/batch/upload — Upload CSV ──────────────────────────────
router.post('/batch/upload', auth, upload.single('file'), (0, errorHandler_1.asyncHandler)(async (req, res) => {
    if (!req.file)
        throw new errorHandler_1.ValidationError('Fichier CSV requis');
    const csvContent = req.file.buffer.toString('utf-8');
    const records = (0, batchSearchService_1.parseCSVToRecords)(csvContent);
    if (records.length === 0) {
        throw new errorHandler_1.ValidationError('Aucun enregistrement valide dans le fichier CSV. Vérifiez les en-têtes (nom, prenom, date_naissance, nationalite...)');
    }
    if (records.length > 1000) {
        throw new errorHandler_1.ValidationError('Maximum 1000 lignes par fichier');
    }
    const searchTypes = req.body.searchTypes
        ? JSON.parse(req.body.searchTypes)
        : ['PPE', 'SANCTIONS', 'GEL_AVOIRS', 'INTERPOL', 'PAYS_RISQUE'];
    const opts = {
        records,
        searchTypes,
        confidenceThreshold: parseFloat(req.body.confidenceThreshold || '0.72'),
        concurrency: parseInt(req.body.concurrency || '3', 10),
        name: req.body.name || req.file.originalname,
        userId: req.user.id,
    };
    const result = await (0, batchSearchService_1.runBatchSearch)(opts);
    res.json({ success: true, data: result });
}));
// ─── GET /api/search/batch — List user batch searches ────────────────────────
router.get('/batch', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const searches = await (0, batchSearchService_1.getUserBatchSearches)(req.user.id);
    res.json({ success: true, data: { searches } });
}));
// ─── GET /api/search/batch/:id — Get batch results ───────────────────────────
router.get('/batch/:id', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const batch = await (0, batchSearchService_1.getBatchSearch)(req.params.id, req.user.id);
    if (!batch)
        throw new errorHandler_1.ValidationError('Lot de recherche introuvable');
    res.json({ success: true, data: { batch } });
}));
// ─── GET /api/search/batch/:id/export — Export CSV ───────────────────────────
router.get('/batch/:id/export', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const batch = await (0, batchSearchService_1.getBatchSearch)(req.params.id, req.user.id);
    if (!batch)
        throw new errorHandler_1.ValidationError('Lot de recherche introuvable');
    const mappedResults = (batch.results || []).map((r) => ({
        rowIndex: r.rowIndex,
        nom: r.inputData?.nom || '',
        prenom: r.inputData?.prenom || '',
        reference: r.inputData?.reference || '',
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
    const csv = (0, batchSearchService_1.exportBatchResultsToCSV)(mappedResults);
    const filename = `batch-${batch.id}-${new Date().toISOString().substring(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compatibility
}));
// ─── GET /api/search/stats — Global search stats ─────────────────────────────
router.get('/stats', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const userId = req.user.id;
    const [totalSearches, totalSaved, totalBatches, recentSearches,] = await Promise.all([
        prisma_1.default.searchHistory.count({ where: { userId } }),
        prisma_1.default.savedSearch.count({ where: { userId } }),
        prisma_1.default.batchSearch.count({ where: { userId } }),
        prisma_1.default.searchHistory.findMany({
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
exports.default = router;
//# sourceMappingURL=search.js.map