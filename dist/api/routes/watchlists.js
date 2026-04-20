"use strict";
/**
 * Watchlist Routes — /api/watchlists
 *
 *  POST /api/watchlists                            Créer une watchlist
 *  GET  /api/watchlists                            Lister watchlists utilisateur
 *  GET  /api/watchlists/stats                      Statistiques globales
 *  GET  /api/watchlists/alerts                     Toutes les alertes non lues
 *  PUT  /api/watchlists/alerts/read                Marquer alertes comme lues
 *  GET  /api/watchlists/:id                        Détails d'une watchlist
 *  PUT  /api/watchlists/:id                        Modifier une watchlist
 *  DELETE /api/watchlists/:id                      Supprimer une watchlist
 *  POST /api/watchlists/:id/entities               Ajouter entité
 *  DELETE /api/watchlists/:id/entities/:nom        Retirer entité
 *  POST /api/watchlists/:id/check                  Vérifier manuellement
 *  GET  /api/watchlists/:id/alerts                 Alertes de cette watchlist
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const watchlistService_1 = require("../../services/watchlistService");
const prisma_1 = __importDefault(require("../../lib/prisma"));
const router = (0, express_1.Router)();
const auth = auth_1.authenticateToken;
// ─── Schemas ────────────────────────────────────────────────────────────────
const createWatchlistSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    description: zod_1.z.string().max(500).optional(),
    color: zod_1.z.string().optional(),
    checkFrequency: zod_1.z.enum(['REALTIME', 'HOURLY', 'DAILY', 'WEEKLY']).default('DAILY'),
    entities: zod_1.z.array(zod_1.z.object({
        type: zod_1.z.enum(['CLIENT', 'DOSSIER', 'EXTERNE']),
        id: zod_1.z.string().optional(),
        nom: zod_1.z.string().min(1),
        prenom: zod_1.z.string().optional(),
        dateNaissance: zod_1.z.string().optional(),
        nationalite: zod_1.z.string().optional(),
        pays: zod_1.z.string().optional(),
        entreprise: zod_1.z.string().optional(),
        criteria: zod_1.z.array(zod_1.z.string()).optional(),
    })).default([]),
});
const entitySchema = zod_1.z.object({
    type: zod_1.z.enum(['CLIENT', 'DOSSIER', 'EXTERNE']),
    id: zod_1.z.string().optional(),
    nom: zod_1.z.string().min(1),
    prenom: zod_1.z.string().optional(),
    dateNaissance: zod_1.z.string().optional(),
    nationalite: zod_1.z.string().optional(),
    pays: zod_1.z.string().optional(),
    entreprise: zod_1.z.string().optional(),
    criteria: zod_1.z.array(zod_1.z.string()).optional(),
});
// ─── GET /api/watchlists/stats ────────────────────────────────────────────────
router.get('/stats', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const stats = await (0, watchlistService_1.getWatchlistStats)(req.user.id);
    res.json({ success: true, data: stats });
}));
// ─── GET /api/watchlists/alerts ───────────────────────────────────────────────
router.get('/alerts', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const alerts = await (0, watchlistService_1.getUnreadAlerts)(req.user.id);
    res.json({ success: true, data: { alerts, count: alerts.length } });
}));
// ─── PUT /api/watchlists/alerts/read ─────────────────────────────────────────
router.put('/alerts/read', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { alertIds } = zod_1.z.object({
        alertIds: zod_1.z.union([zod_1.z.array(zod_1.z.string()), zod_1.z.literal('all')])
    }).parse(req.body);
    if (alertIds === 'all') {
        // Mark all alerts for this user as read
        const watchlists = await prisma_1.default.watchlist.findMany({
            where: { userId: req.user.id },
            select: { id: true }
        });
        await prisma_1.default.watchlistAlert.updateMany({
            where: { watchlistId: { in: watchlists.map((w) => w.id) }, isRead: false },
            data: { isRead: true }
        });
    }
    else {
        await (0, watchlistService_1.markAlertsRead)(alertIds);
    }
    res.json({ success: true });
}));
// ─── POST /api/watchlists ─────────────────────────────────────────────────────
router.post('/', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = createWatchlistSchema.parse(req.body);
    const watchlist = await (0, watchlistService_1.createWatchlist)(req.user.id, data.name, data.description, data.entities.map(e => ({ ...e, addedAt: new Date() })), data.checkFrequency, data.color);
    res.status(201).json({ success: true, data: { watchlist } });
}));
// ─── GET /api/watchlists ──────────────────────────────────────────────────────
router.get('/', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const watchlists = await (0, watchlistService_1.getUserWatchlists)(req.user.id);
    res.json({ success: true, data: { watchlists } });
}));
// ─── GET /api/watchlists/:id ──────────────────────────────────────────────────
router.get('/:id', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const watchlist = await prisma_1.default.watchlist.findFirst({
        where: { id: req.params.id, userId: req.user.id },
        include: {
            alerts: {
                orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
                take: 50,
            },
            _count: { select: { alerts: true } }
        }
    });
    if (!watchlist)
        throw new errorHandler_1.ValidationError('Watchlist introuvable');
    res.json({ success: true, data: { watchlist } });
}));
// ─── PUT /api/watchlists/:id ──────────────────────────────────────────────────
router.put('/:id', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const data = createWatchlistSchema.partial().parse(req.body);
    const existing = await prisma_1.default.watchlist.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    if (!existing)
        throw new errorHandler_1.ValidationError('Watchlist introuvable');
    const updated = await prisma_1.default.watchlist.update({
        where: { id: req.params.id },
        data: {
            ...(data.name ? { name: data.name } : {}),
            ...(data.description !== undefined ? { description: data.description } : {}),
            ...(data.color ? { color: data.color } : {}),
            ...(data.checkFrequency ? { checkFrequency: data.checkFrequency } : {}),
        }
    });
    res.json({ success: true, data: { watchlist: updated } });
}));
// ─── DELETE /api/watchlists/:id ───────────────────────────────────────────────
router.delete('/:id', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    await (0, watchlistService_1.deleteWatchlist)(req.params.id, req.user.id);
    res.json({ success: true });
}));
// ─── POST /api/watchlists/:id/entities — Add entity ──────────────────────────
router.post('/:id/entities', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const entity = entitySchema.parse(req.body);
    const watchlist = await prisma_1.default.watchlist.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    if (!watchlist)
        throw new errorHandler_1.ValidationError('Watchlist introuvable');
    const updated = await (0, watchlistService_1.addEntityToWatchlist)(req.params.id, {
        ...entity,
        addedAt: new Date()
    });
    res.json({ success: true, data: { watchlist: updated } });
}));
// ─── DELETE /api/watchlists/:id/entities/:nom ─────────────────────────────────
router.delete('/:id/entities/:nom', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const watchlist = await prisma_1.default.watchlist.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    if (!watchlist)
        throw new errorHandler_1.ValidationError('Watchlist introuvable');
    const updated = await (0, watchlistService_1.removeEntityFromWatchlist)(req.params.id, decodeURIComponent(req.params.nom));
    res.json({ success: true, data: { watchlist: updated } });
}));
// ─── POST /api/watchlists/:id/check — Manual check ───────────────────────────
router.post('/:id/check', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const watchlist = await prisma_1.default.watchlist.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    if (!watchlist)
        throw new errorHandler_1.ValidationError('Watchlist introuvable');
    const results = await (0, watchlistService_1.checkWatchlist)(req.params.id);
    const totalNewAlerts = results.reduce((sum, r) => sum + r.alerts.length, 0);
    res.json({
        success: true,
        data: {
            results,
            totalNewAlerts,
            checkedEntities: results.length,
            entitiesWithAlerts: results.filter(r => r.hasChanges).length,
        }
    });
}));
// ─── GET /api/watchlists/:id/alerts ──────────────────────────────────────────
router.get('/:id/alerts', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const watchlist = await prisma_1.default.watchlist.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    if (!watchlist)
        throw new errorHandler_1.ValidationError('Watchlist introuvable');
    const page = parseInt(req.query.page || '1', 10);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const skip = (page - 1) * limit;
    const [alerts, total] = await Promise.all([
        prisma_1.default.watchlistAlert.findMany({
            where: { watchlistId: req.params.id },
            orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
            skip,
            take: limit,
        }),
        prisma_1.default.watchlistAlert.count({ where: { watchlistId: req.params.id } }),
    ]);
    res.json({ success: true, data: { alerts, total, page, pageSize: limit } });
}));
exports.default = router;
//# sourceMappingURL=watchlists.js.map