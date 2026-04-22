"use strict";
/**
 * Intelligence Routes — /api/intelligence
 *
 *  POST /api/intelligence/report           Générer un rapport d'intelligence
 *  GET  /api/intelligence/reports          Lister les rapports de l'utilisateur
 *  GET  /api/intelligence/reports/:id      Récupérer un rapport
 *  DELETE /api/intelligence/reports/:id    Supprimer un rapport
 *  POST /api/intelligence/osint            Recherche OSINT rapide (sans rapport)
 *  POST /api/intelligence/fuzzy            Test de correspondance fuzzy
 *  GET  /api/intelligence/timeline         Timeline d'un client/dossier
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const intelligenceService_1 = require("../../services/intelligenceService");
const osintMegaService_1 = require("../../services/osintMegaService");
const fuzzyMatchService_1 = require("../../services/fuzzyMatchService");
const universalSearchService_1 = require("../../services/universalSearchService");
const prisma_1 = __importDefault(require("../../lib/prisma"));
const router = (0, express_1.Router)();
const auth = auth_1.authenticateToken;
// ─── Schemas ────────────────────────────────────────────────────────────────
const reportInputSchema = zod_1.z.object({
    nom: zod_1.z.string().min(1),
    prenom: zod_1.z.string().optional(),
    dateNaissance: zod_1.z.string().optional(),
    nationalite: zod_1.z.string().optional(),
    pays: zod_1.z.string().optional(),
    entreprise: zod_1.z.string().optional(),
    siret: zod_1.z.string().optional(),
    subjectType: zod_1.z.enum(['PERSON', 'COMPANY', 'MIXED']).default('PERSON'),
    clientId: zod_1.z.string().optional(),
    dossierId: zod_1.z.string().optional(),
});
const osintSchema = zod_1.z.object({
    nom: zod_1.z.string().min(1),
    prenom: zod_1.z.string().optional(),
    dateNaissance: zod_1.z.string().optional(),
    nationalite: zod_1.z.string().optional(),
    pays: zod_1.z.string().optional(),
    entreprise: zod_1.z.string().optional(),
    siret: zod_1.z.string().optional(),
    type: zod_1.z.enum(['PERSON', 'COMPANY', 'MIXED']).default('PERSON'),
    confidenceThreshold: zod_1.z.number().min(0).max(1).default(0.72),
    mode: zod_1.z.enum(['full', 'quick']).default('quick'),
});
const fuzzySchema = zod_1.z.object({
    query: zod_1.z.string().min(1),
    candidate: zod_1.z.string().min(1).optional(),
    list: zod_1.z.array(zod_1.z.string()).optional(),
    queryFirst: zod_1.z.string().optional(),
    queryLast: zod_1.z.string().optional(),
    candidateFirst: zod_1.z.string().optional(),
    candidateLast: zod_1.z.string().optional(),
    threshold: zod_1.z.number().min(0).max(1).default(0.72),
});
const timelineSchema = zod_1.z.object({
    clientId: zod_1.z.string().optional(),
    dossierId: zod_1.z.string().optional(),
    userId: zod_1.z.string().optional(),
    dateFrom: zod_1.z.string().optional(),
    dateTo: zod_1.z.string().optional(),
    types: zod_1.z.array(zod_1.z.string()).optional(),
    limit: zod_1.z.coerce.number().min(1).max(500).default(200),
});
// ─── POST /api/intelligence/report ───────────────────────────────────────────
router.post('/report', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = reportInputSchema.parse(req.body);
    // Check if recent report exists (within 24h) to avoid duplicate work
    const recentReport = await prisma_1.default.intelligenceReport.findFirst({
        where: {
            userId: req.user.id,
            subjectName: data.prenom ? `${data.prenom} ${data.nom}` : data.nom,
            createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
        },
        orderBy: { createdAt: 'desc' }
    });
    if (recentReport && !req.query.force) {
        return res.json({
            success: true,
            data: { report: recentReport, cached: true, message: 'Rapport récent trouvé (< 24h). Ajoutez ?force=1 pour régénérer.' }
        });
    }
    const input = {
        ...data,
        requestedBy: req.user.id,
    };
    const report = await (0, intelligenceService_1.generateIntelligenceReport)(input);
    res.json({ success: true, data: { report } });
}));
// ─── GET /api/intelligence/reports ───────────────────────────────────────────
router.get('/reports', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const reports = await (0, intelligenceService_1.getUserReports)(req.user.id);
    res.json({ success: true, data: { reports } });
}));
// ─── GET /api/intelligence/reports/:id ───────────────────────────────────────
router.get('/reports/:id', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const report = await (0, intelligenceService_1.getReport)(req.params.id, req.user.id);
    if (!report)
        throw new errorHandler_1.ValidationError('Rapport introuvable');
    res.json({ success: true, data: { report } });
}));
// ─── DELETE /api/intelligence/reports/:id ────────────────────────────────────
router.delete('/reports/:id', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    await prisma_1.default.intelligenceReport.deleteMany({
        where: { id: req.params.id, userId: req.user.id }
    });
    res.json({ success: true });
}));
// ─── POST /api/intelligence/osint — Quick OSINT ───────────────────────────────
router.post('/osint', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = osintSchema.parse(req.body);
    const query = {
        nom: data.nom,
        prenom: data.prenom,
        dateNaissance: data.dateNaissance,
        nationalite: data.nationalite,
        pays: data.pays,
        entreprise: data.entreprise,
        siret: data.siret,
        type: data.type,
        confidenceThreshold: data.confidenceThreshold,
    };
    const report = data.mode === 'full'
        ? await (0, osintMegaService_1.runOsintMega)(query)
        : await (0, osintMegaService_1.runOsintQuick)(query);
    res.json({ success: true, data: { report } });
}));
// ─── POST /api/intelligence/fuzzy — Fuzzy name matching ──────────────────────
router.post('/fuzzy', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = fuzzySchema.parse(req.body);
    if (data.candidate) {
        // Single pair comparison
        const result = (0, fuzzyMatchService_1.computeFuzzyMatch)(data.query, data.candidate, data.threshold);
        return res.json({ success: true, data: { result } });
    }
    if (data.queryFirst && data.queryLast && data.candidateFirst && data.candidateLast) {
        // Full name comparison
        const result = (0, fuzzyMatchService_1.matchFullName)(data.queryFirst, data.queryLast, data.candidateFirst, data.candidateLast, data.threshold);
        return res.json({ success: true, data: { result } });
    }
    if (data.list && data.list.length > 0) {
        // Screen against list
        const results = (0, fuzzyMatchService_1.screenNameAgainstList)(data.query, data.list, data.threshold);
        return res.json({ success: true, data: { results, matchCount: results.length } });
    }
    throw new errorHandler_1.ValidationError('Fournir: candidate, ou queryFirst+queryLast+candidateFirst+candidateLast, ou list');
}));
// ─── GET /api/intelligence/timeline ──────────────────────────────────────────
router.get('/timeline', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const params = timelineSchema.parse(req.query);
    if (!params.clientId && !params.dossierId && !params.userId) {
        throw new errorHandler_1.ValidationError('Fournir clientId, dossierId ou userId');
    }
    // Restrict userId timeline to self unless admin/referent
    if (params.userId && params.userId !== req.user.id) {
        const role = req.user.role;
        if (!['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(role)) {
            throw new errorHandler_1.ValidationError('Accès refusé à la timeline d\'un autre utilisateur');
        }
    }
    const events = await (0, universalSearchService_1.getEntityTimeline)({
        clientId: params.clientId,
        dossierId: params.dossierId,
        userId: params.userId,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        types: params.types,
        limit: params.limit,
    });
    res.json({
        success: true,
        data: {
            events,
            total: events.length,
            dateRange: {
                from: events.length > 0 ? events[events.length - 1].timestamp : null,
                to: events.length > 0 ? events[0].timestamp : null,
            }
        }
    });
}));
// ─── POST /api/intelligence/timeline — Timeline for a client by name ─────────
router.post('/timeline', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { nom, prenom, dateFrom, dateTo, limit } = zod_1.z.object({
        nom: zod_1.z.string().min(1),
        prenom: zod_1.z.string().optional(),
        dateFrom: zod_1.z.string().optional(),
        dateTo: zod_1.z.string().optional(),
        limit: zod_1.z.number().default(200),
    }).parse(req.body);
    // Find client by name
    const client = await prisma_1.default.client.findFirst({
        where: {
            nom: { contains: nom, mode: 'insensitive' },
            ...(prenom ? { prenom: { contains: prenom, mode: 'insensitive' } } : {}),
        }
    });
    if (!client) {
        return res.json({
            success: true,
            data: { events: [], total: 0, message: 'Client non trouvé en base interne' }
        });
    }
    const events = await (0, universalSearchService_1.getEntityTimeline)({
        clientId: client.id,
        dateFrom,
        dateTo,
        limit,
    });
    res.json({
        success: true,
        data: {
            client: { id: client.id, nom: client.nom, prenom: client.prenom },
            events,
            total: events.length,
        }
    });
}));
exports.default = router;
//# sourceMappingURL=intelligence.js.map