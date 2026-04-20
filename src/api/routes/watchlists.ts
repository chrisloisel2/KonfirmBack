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

import { Router, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ValidationError } from '../../middleware/errorHandler';
import { authenticateToken, AuthenticatedRequest } from '../../middleware/auth';
import {
	createWatchlist,
	getUserWatchlists,
	addEntityToWatchlist,
	removeEntityFromWatchlist,
	checkWatchlist,
	getUnreadAlerts,
	markAlertsRead,
	deleteWatchlist,
	getWatchlistStats,
	type WatchlistEntity,
} from '../../services/watchlistService';
import prisma from '../../lib/prisma';

const router = Router();
const auth = authenticateToken as any;

// ─── Schemas ────────────────────────────────────────────────────────────────

const createWatchlistSchema = z.object({
	name:           z.string().min(1).max(100),
	description:    z.string().max(500).optional(),
	color:          z.string().optional(),
	checkFrequency: z.enum(['REALTIME', 'HOURLY', 'DAILY', 'WEEKLY']).default('DAILY'),
	entities: z.array(z.object({
		type:          z.enum(['CLIENT', 'DOSSIER', 'EXTERNE']),
		id:            z.string().optional(),
		nom:           z.string().min(1),
		prenom:        z.string().optional(),
		dateNaissance: z.string().optional(),
		nationalite:   z.string().optional(),
		pays:          z.string().optional(),
		entreprise:    z.string().optional(),
		criteria:      z.array(z.string()).optional(),
	})).default([]),
});

const entitySchema = z.object({
	type:          z.enum(['CLIENT', 'DOSSIER', 'EXTERNE']),
	id:            z.string().optional(),
	nom:           z.string().min(1),
	prenom:        z.string().optional(),
	dateNaissance: z.string().optional(),
	nationalite:   z.string().optional(),
	pays:          z.string().optional(),
	entreprise:    z.string().optional(),
	criteria:      z.array(z.string()).optional(),
});

// ─── GET /api/watchlists/stats ────────────────────────────────────────────────

router.get('/stats', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const stats = await getWatchlistStats(req.user!.id);
	res.json({ success: true, data: stats });
}));

// ─── GET /api/watchlists/alerts ───────────────────────────────────────────────

router.get('/alerts', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const alerts = await getUnreadAlerts(req.user!.id);
	res.json({ success: true, data: { alerts, count: alerts.length } });
}));

// ─── PUT /api/watchlists/alerts/read ─────────────────────────────────────────

router.put('/alerts/read', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const { alertIds } = z.object({
		alertIds: z.union([z.array(z.string()), z.literal('all')])
	}).parse(req.body);

	if (alertIds === 'all') {
		// Mark all alerts for this user as read
		const watchlists = await (prisma as any).watchlist.findMany({
			where: { userId: req.user!.id },
			select: { id: true }
		});
		await (prisma as any).watchlistAlert.updateMany({
			where: { watchlistId: { in: watchlists.map((w: any) => w.id) }, isRead: false },
			data: { isRead: true }
		});
	} else {
		await markAlertsRead(alertIds);
	}

	res.json({ success: true });
}));

// ─── POST /api/watchlists ─────────────────────────────────────────────────────

router.post('/', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const data = createWatchlistSchema.parse(req.body);

	const watchlist = await createWatchlist(
		req.user!.id,
		data.name,
		data.description,
		data.entities.map(e => ({ ...e, addedAt: new Date() } as WatchlistEntity)),
		data.checkFrequency,
		data.color,
	);

	res.status(201).json({ success: true, data: { watchlist } });
}));

// ─── GET /api/watchlists ──────────────────────────────────────────────────────

router.get('/', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const watchlists = await getUserWatchlists(req.user!.id);
	res.json({ success: true, data: { watchlists } });
}));

// ─── GET /api/watchlists/:id ──────────────────────────────────────────────────

router.get('/:id', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const watchlist = await (prisma as any).watchlist.findFirst({
		where: { id: req.params.id, userId: req.user!.id },
		include: {
			alerts: {
				orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
				take: 50,
			},
			_count: { select: { alerts: true } }
		}
	});

	if (!watchlist) throw new ValidationError('Watchlist introuvable');
	res.json({ success: true, data: { watchlist } });
}));

// ─── PUT /api/watchlists/:id ──────────────────────────────────────────────────

router.put('/:id', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const data = createWatchlistSchema.partial().parse(req.body);

	const existing = await (prisma as any).watchlist.findFirst({
		where: { id: req.params.id, userId: req.user!.id }
	});
	if (!existing) throw new ValidationError('Watchlist introuvable');

	const updated = await (prisma as any).watchlist.update({
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

router.delete('/:id', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	await deleteWatchlist(req.params.id, req.user!.id);
	res.json({ success: true });
}));

// ─── POST /api/watchlists/:id/entities — Add entity ──────────────────────────

router.post('/:id/entities', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const entity = entitySchema.parse(req.body);

	const watchlist = await (prisma as any).watchlist.findFirst({
		where: { id: req.params.id, userId: req.user!.id }
	});
	if (!watchlist) throw new ValidationError('Watchlist introuvable');

	const updated = await addEntityToWatchlist(req.params.id, {
		...entity,
		addedAt: new Date()
	} as WatchlistEntity);

	res.json({ success: true, data: { watchlist: updated } });
}));

// ─── DELETE /api/watchlists/:id/entities/:nom ─────────────────────────────────

router.delete('/:id/entities/:nom', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const watchlist = await (prisma as any).watchlist.findFirst({
		where: { id: req.params.id, userId: req.user!.id }
	});
	if (!watchlist) throw new ValidationError('Watchlist introuvable');

	const updated = await removeEntityFromWatchlist(
		req.params.id,
		decodeURIComponent(req.params.nom)
	);

	res.json({ success: true, data: { watchlist: updated } });
}));

// ─── POST /api/watchlists/:id/check — Manual check ───────────────────────────

router.post('/:id/check', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const watchlist = await (prisma as any).watchlist.findFirst({
		where: { id: req.params.id, userId: req.user!.id }
	});
	if (!watchlist) throw new ValidationError('Watchlist introuvable');

	const results = await checkWatchlist(req.params.id);
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

router.get('/:id/alerts', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const watchlist = await (prisma as any).watchlist.findFirst({
		where: { id: req.params.id, userId: req.user!.id }
	});
	if (!watchlist) throw new ValidationError('Watchlist introuvable');

	const page  = parseInt(req.query.page as string || '1', 10);
	const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 200);
	const skip  = (page - 1) * limit;

	const [alerts, total] = await Promise.all([
		(prisma as any).watchlistAlert.findMany({
			where: { watchlistId: req.params.id },
			orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
			skip,
			take: limit,
		}),
		(prisma as any).watchlistAlert.count({ where: { watchlistId: req.params.id } }),
	]);

	res.json({ success: true, data: { alerts, total, page, pageSize: limit } });
}));

export default router;
