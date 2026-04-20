/**
 * Watchlist Service — Surveillance Continue
 *
 * Permet de surveiller des entités (personnes/entreprises) en continu:
 *   - Création/gestion de listes de surveillance
 *   - Vérification automatique à intervalle configurable
 *   - Alertes temps réel lors d'un changement de statut
 *   - Intégration avec OSINT Mega pour les vérifications externes
 *   - Intégration avec la base interne pour les changements de dossiers
 *   - Notifications par email (Nodemailer)
 */

import prisma from '../lib/prisma';
import { logSystemEvent } from '../utils/logger';
import { runOsintMega, runOsintQuick, OsintQuery } from './osintMegaService';

export interface WatchlistEntity {
	type: 'CLIENT' | 'DOSSIER' | 'EXTERNE';
	id?: string;
	nom: string;
	prenom?: string;
	dateNaissance?: string;
	nationalite?: string;
	pays?: string;
	entreprise?: string;
	criteria?: string[];
	addedAt: Date;
}

export interface WatchlistCheckResult {
	watchlistId: string;
	watchlistName: string;
	entityName: string;
	hasChanges: boolean;
	alerts: WatchlistAlertPayload[];
	checkedAt: Date;
}

export interface WatchlistAlertPayload {
	type: string;
	severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
	title: string;
	description: string;
	details?: any;
	sourceUrl?: string;
}

// ─── Create watchlist ────────────────────────────────────────────────────────

export async function createWatchlist(
	userId: string,
	name: string,
	description: string | undefined,
	entities: WatchlistEntity[],
	checkFrequency: string = 'DAILY',
	color?: string
) {
	return (prisma as any).watchlist.create({
		data: {
			userId,
			name,
			description,
			color: color || '#3B82F6',
			entities,
			checkFrequency,
			isActive: true,
		}
	});
}

// ─── Get user watchlists ─────────────────────────────────────────────────────

export async function getUserWatchlists(userId: string) {
	return (prisma as any).watchlist.findMany({
		where: { userId, isActive: true },
		include: {
			alerts: {
				where: { isRead: false },
				orderBy: { createdAt: 'desc' },
				take: 5,
			},
			_count: { select: { alerts: true } }
		},
		orderBy: { updatedAt: 'desc' },
	});
}

// ─── Add entity to watchlist ─────────────────────────────────────────────────

export async function addEntityToWatchlist(watchlistId: string, entity: WatchlistEntity) {
	const watchlist = await (prisma as any).watchlist.findUnique({
		where: { id: watchlistId }
	});
	if (!watchlist) throw new Error('Watchlist introuvable');

	const entities = [...(watchlist.entities as WatchlistEntity[]), { ...entity, addedAt: new Date() }];
	return (prisma as any).watchlist.update({
		where: { id: watchlistId },
		data: { entities }
	});
}

// ─── Remove entity from watchlist ────────────────────────────────────────────

export async function removeEntityFromWatchlist(watchlistId: string, entityNom: string) {
	const watchlist = await (prisma as any).watchlist.findUnique({
		where: { id: watchlistId }
	});
	if (!watchlist) throw new Error('Watchlist introuvable');

	const entities = (watchlist.entities as WatchlistEntity[])
		.filter(e => e.nom !== entityNom);
	return (prisma as any).watchlist.update({
		where: { id: watchlistId },
		data: { entities }
	});
}

// ─── Check one watchlist ─────────────────────────────────────────────────────

export async function checkWatchlist(watchlistId: string): Promise<WatchlistCheckResult[]> {
	const watchlist = await (prisma as any).watchlist.findUnique({
		where: { id: watchlistId }
	});
	if (!watchlist) throw new Error('Watchlist introuvable');

	const entities = watchlist.entities as WatchlistEntity[];
	const results: WatchlistCheckResult[] = [];

	for (const entity of entities) {
		try {
			const alerts = await checkEntityForChanges(entity, watchlistId);

			// Save alerts to DB
			for (const alert of alerts) {
				await (prisma as any).watchlistAlert.create({
					data: {
						watchlistId,
						entityName: entity.nom,
						entityType: entity.type,
						entityId: entity.id,
						alertType: alert.type,
						severity: alert.severity,
						title: alert.title,
						description: alert.description,
						details: alert.details,
						sourceUrl: alert.sourceUrl,
					}
				});
			}

			results.push({
				watchlistId,
				watchlistName: watchlist.name,
				entityName: entity.nom,
				hasChanges: alerts.length > 0,
				alerts,
				checkedAt: new Date(),
			});
		} catch (e) {
			logSystemEvent({
				action: 'watchlist_check_error',
				component: 'watchlistService',
				details: { watchlistId, entityName: entity.nom, error: String(e) },
				severity: 'error',
			});
		}
	}

	// Update lastCheckedAt and totalAlerts
	await (prisma as any).watchlist.update({
		where: { id: watchlistId },
		data: {
			lastCheckedAt: new Date(),
			totalAlerts: { increment: results.reduce((sum, r) => sum + r.alerts.length, 0) }
		}
	});

	return results;
}

// ─── Check entity for changes ────────────────────────────────────────────────

async function checkEntityForChanges(
	entity: WatchlistEntity,
	watchlistId: string
): Promise<WatchlistAlertPayload[]> {
	const alerts: WatchlistAlertPayload[] = [];

	// Run quick OSINT check
	const osintQuery: OsintQuery = {
		nom: entity.nom,
		prenom: entity.prenom,
		dateNaissance: entity.dateNaissance,
		nationalite: entity.nationalite,
		pays: entity.pays,
		entreprise: entity.entreprise,
		type: entity.prenom ? 'PERSON' : (entity.entreprise ? 'COMPANY' : 'PERSON'),
		confidenceThreshold: 0.75,
	};

	const report = await runOsintQuick(osintQuery);

	// Check for critical matches
	for (const match of report.criticalMatches) {
		alerts.push({
			type: `NEW_${match.category}`,
			severity: 'CRITICAL',
			title: `🚨 Correspondance critique: ${match.name}`,
			description: `${match.sourceId}: ${match.snippet || 'Correspondance détectée'}`,
			details: { match, report: { riskScore: report.riskScore, overallRisk: report.overallRisk } },
			sourceUrl: match.url,
		});
	}

	for (const match of report.highMatches) {
		alerts.push({
			type: `NEW_${match.category}`,
			severity: 'HIGH',
			title: `⚠️ Alerte haute: ${match.name}`,
			description: `${match.sourceId}: ${match.snippet || 'Correspondance détectée'}`,
			details: { match },
			sourceUrl: match.url,
		});
	}

	// Check internal DB for changes if it's a tracked client
	if (entity.id && entity.type === 'CLIENT') {
		const internalAlerts = await checkInternalClientChanges(entity.id, watchlistId);
		alerts.push(...internalAlerts);
	}

	if (entity.id && entity.type === 'DOSSIER') {
		const internalAlerts = await checkInternalDossierChanges(entity.id, watchlistId);
		alerts.push(...internalAlerts);
	}

	return alerts;
}

// ─── Internal change detection ────────────────────────────────────────────────

async function checkInternalClientChanges(
	clientId: string,
	watchlistId: string
): Promise<WatchlistAlertPayload[]> {
	const alerts: WatchlistAlertPayload[] = [];

	// Get client's latest dossiers
	const dossiers = await (prisma as any).dossier.findMany({
		where: { clientId },
		include: {
			exceptions: { where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } },
			scoring:    true,
		},
		orderBy: { updatedAt: 'desc' },
		take: 5,
	});

	for (const dossier of dossiers) {
		// New exceptions
		for (const ex of dossier.exceptions) {
			alerts.push({
				type: 'NEW_EXCEPTION',
				severity: ex.priority === 'CRITIQUE' ? 'CRITICAL' : ex.priority === 'HAUTE' ? 'HIGH' : 'MEDIUM',
				title: `Nouvelle exception: ${ex.type.replace(/_/g, ' ')}`,
				description: ex.description,
				details: { exceptionId: ex.id, dossierId: dossier.id, priority: ex.priority },
			});
		}

		// High score
		if (dossier.scoring && dossier.scoring.niveau === 'CRITIQUE') {
			alerts.push({
				type: 'SCORE_CRITICAL',
				severity: 'CRITICAL',
				title: `Score de risque CRITIQUE: ${dossier.scoring.scoreTotal}/100`,
				description: dossier.scoring.recommandation,
				details: { scoring: dossier.scoring, dossierId: dossier.id },
			});
		}
	}

	return alerts;
}

async function checkInternalDossierChanges(
	dossierId: string,
	watchlistId: string
): Promise<WatchlistAlertPayload[]> {
	const alerts: WatchlistAlertPayload[] = [];

	// Get last known alert time for this watchlist
	const lastAlert = await (prisma as any).watchlistAlert.findFirst({
		where: { watchlistId, entityId: dossierId },
		orderBy: { createdAt: 'desc' },
	});

	const since = lastAlert?.createdAt || new Date(Date.now() - 24 * 3600 * 1000);

	const dossier = await (prisma as any).dossier.findUnique({
		where: { id: dossierId },
		include: {
			exceptions: { where: { createdAt: { gte: since } } },
			recherches: { where: { executedAt: { gte: since }, confidence: { gte: 0.7 } } },
		},
	});

	if (!dossier) return alerts;

	for (const ex of dossier.exceptions || []) {
		alerts.push({
			type: 'NEW_EXCEPTION',
			severity: ex.priority === 'CRITIQUE' ? 'CRITICAL' : 'HIGH',
			title: `Exception: ${ex.type}`,
			description: ex.description,
			details: { exceptionId: ex.id },
		});
	}

	for (const r of dossier.recherches || []) {
		if (r.confidence >= 0.8 && r.matches && (r.matches as any[]).length > 0) {
			alerts.push({
				type: `RECHERCHE_HIT_${r.type}`,
				severity: r.confidence >= 0.9 ? 'CRITICAL' : 'HIGH',
				title: `Correspondance ${r.type}: ${(r.matches as any[]).length} résultat(s)`,
				description: `Confiance: ${(r.confidence * 100).toFixed(0)}%`,
				details: { rechercheId: r.id, type: r.type, confidence: r.confidence },
			});
		}
	}

	return alerts;
}

// ─── Get unread alerts ────────────────────────────────────────────────────────

export async function getUnreadAlerts(userId: string) {
	const watchlists = await (prisma as any).watchlist.findMany({
		where: { userId },
		select: { id: true },
	});

	return (prisma as any).watchlistAlert.findMany({
		where: {
			watchlistId: { in: watchlists.map((w: any) => w.id) },
			isRead: false,
		},
		include: { watchlist: { select: { name: true, color: true } } },
		orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
		take: 50,
	});
}

// ─── Mark alerts as read ─────────────────────────────────────────────────────

export async function markAlertsRead(alertIds: string[]) {
	return (prisma as any).watchlistAlert.updateMany({
		where: { id: { in: alertIds } },
		data: { isRead: true }
	});
}

// ─── Background job: check all active watchlists ─────────────────────────────

export async function runAllWatchlistChecks(): Promise<void> {
	const now = new Date();
	const toCheck: any[] = [];

	// Collect watchlists due for checking based on frequency
	const all = await (prisma as any).watchlist.findMany({
		where: { isActive: true },
	});

	for (const wl of all) {
		const last = wl.lastCheckedAt ? new Date(wl.lastCheckedAt) : new Date(0);
		const elapsed = now.getTime() - last.getTime();
		const freq = wl.checkFrequency || 'DAILY';

		const threshold =
			freq === 'REALTIME' ? 5 * 60 * 1000 :
			freq === 'HOURLY'   ? 60 * 60 * 1000 :
			freq === 'DAILY'    ? 24 * 3600 * 1000 :
			freq === 'WEEKLY'   ? 7 * 24 * 3600 * 1000 :
			24 * 3600 * 1000;

		if (elapsed >= threshold) {
			toCheck.push(wl);
		}
	}

	logSystemEvent({
		action: 'watchlist_batch_check_start',
		component: 'watchlistService',
		details: { total: all.length, dueForCheck: toCheck.length },
		severity: 'info',
	});

	// Process sequentially to avoid rate-limiting external APIs
	for (const wl of toCheck) {
		try {
			await checkWatchlist(wl.id);
		} catch (e) {
			logSystemEvent({
				action: 'watchlist_batch_check_error',
				component: 'watchlistService',
				details: { watchlistId: wl.id, error: String(e) },
				severity: 'error',
			});
		}
		// Small delay between watchlists to be respectful of APIs
		await new Promise(r => setTimeout(r, 2000));
	}

	logSystemEvent({
		action: 'watchlist_batch_check_complete',
		component: 'watchlistService',
		details: { checked: toCheck.length },
		severity: 'info',
	});
}

// ─── Delete watchlist ─────────────────────────────────────────────────────────

export async function deleteWatchlist(watchlistId: string, userId: string) {
	const wl = await (prisma as any).watchlist.findFirst({
		where: { id: watchlistId, userId }
	});
	if (!wl) throw new Error('Watchlist introuvable ou accès refusé');

	await (prisma as any).watchlistAlert.deleteMany({ where: { watchlistId } });
	return (prisma as any).watchlist.delete({ where: { id: watchlistId } });
}

// ─── Get watchlist stats ──────────────────────────────────────────────────────

export async function getWatchlistStats(userId: string) {
	const watchlists = await (prisma as any).watchlist.findMany({
		where: { userId },
		include: { _count: { select: { alerts: true } } }
	});

	const totalEntities = watchlists.reduce((sum: number, wl: any) => sum + (wl.entities?.length || 0), 0);
	const totalAlerts = watchlists.reduce((sum: number, wl: any) => sum + wl._count.alerts, 0);
	const unreadAlerts = await (prisma as any).watchlistAlert.count({
		where: {
			watchlistId: { in: watchlists.map((w: any) => w.id) },
			isRead: false,
		}
	});
	const criticalAlerts = await (prisma as any).watchlistAlert.count({
		where: {
			watchlistId: { in: watchlists.map((w: any) => w.id) },
			severity: 'CRITICAL',
			isRead: false,
		}
	});

	return {
		totalWatchlists: watchlists.length,
		activeWatchlists: watchlists.filter((w: any) => w.isActive).length,
		totalEntities,
		totalAlerts,
		unreadAlerts,
		criticalAlerts,
	};
}
