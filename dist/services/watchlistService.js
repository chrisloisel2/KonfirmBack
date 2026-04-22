"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWatchlist = createWatchlist;
exports.getUserWatchlists = getUserWatchlists;
exports.addEntityToWatchlist = addEntityToWatchlist;
exports.removeEntityFromWatchlist = removeEntityFromWatchlist;
exports.checkWatchlist = checkWatchlist;
exports.getUnreadAlerts = getUnreadAlerts;
exports.markAlertsRead = markAlertsRead;
exports.runAllWatchlistChecks = runAllWatchlistChecks;
exports.deleteWatchlist = deleteWatchlist;
exports.getWatchlistStats = getWatchlistStats;
const prisma_1 = __importDefault(require("../lib/prisma"));
const logger_1 = require("../utils/logger");
const osintMegaService_1 = require("./osintMegaService");
// ─── Create watchlist ────────────────────────────────────────────────────────
async function createWatchlist(userId, name, description, entities, checkFrequency = 'DAILY', color) {
    return prisma_1.default.watchlist.create({
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
async function getUserWatchlists(userId) {
    return prisma_1.default.watchlist.findMany({
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
async function addEntityToWatchlist(watchlistId, entity) {
    const watchlist = await prisma_1.default.watchlist.findUnique({
        where: { id: watchlistId }
    });
    if (!watchlist)
        throw new Error('Watchlist introuvable');
    const entities = [...watchlist.entities, { ...entity, addedAt: new Date() }];
    return prisma_1.default.watchlist.update({
        where: { id: watchlistId },
        data: { entities }
    });
}
// ─── Remove entity from watchlist ────────────────────────────────────────────
async function removeEntityFromWatchlist(watchlistId, entityNom) {
    const watchlist = await prisma_1.default.watchlist.findUnique({
        where: { id: watchlistId }
    });
    if (!watchlist)
        throw new Error('Watchlist introuvable');
    const entities = watchlist.entities
        .filter(e => e.nom !== entityNom);
    return prisma_1.default.watchlist.update({
        where: { id: watchlistId },
        data: { entities }
    });
}
// ─── Check one watchlist ─────────────────────────────────────────────────────
async function checkWatchlist(watchlistId) {
    const watchlist = await prisma_1.default.watchlist.findUnique({
        where: { id: watchlistId }
    });
    if (!watchlist)
        throw new Error('Watchlist introuvable');
    const entities = watchlist.entities;
    const results = [];
    for (const entity of entities) {
        try {
            const alerts = await checkEntityForChanges(entity, watchlistId);
            // Save alerts to DB
            for (const alert of alerts) {
                await prisma_1.default.watchlistAlert.create({
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
        }
        catch (e) {
            (0, logger_1.logSystemEvent)({
                action: 'watchlist_check_error',
                component: 'watchlistService',
                details: { watchlistId, entityName: entity.nom, error: String(e) },
                severity: 'error',
            });
        }
    }
    // Update lastCheckedAt and totalAlerts
    await prisma_1.default.watchlist.update({
        where: { id: watchlistId },
        data: {
            lastCheckedAt: new Date(),
            totalAlerts: { increment: results.reduce((sum, r) => sum + r.alerts.length, 0) }
        }
    });
    return results;
}
// ─── Check entity for changes ────────────────────────────────────────────────
async function checkEntityForChanges(entity, watchlistId) {
    const alerts = [];
    // Run quick OSINT check
    const osintQuery = {
        nom: entity.nom,
        prenom: entity.prenom,
        dateNaissance: entity.dateNaissance,
        nationalite: entity.nationalite,
        pays: entity.pays,
        entreprise: entity.entreprise,
        type: entity.prenom ? 'PERSON' : (entity.entreprise ? 'COMPANY' : 'PERSON'),
        confidenceThreshold: 0.75,
    };
    const report = await (0, osintMegaService_1.runOsintQuick)(osintQuery);
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
async function checkInternalClientChanges(clientId, watchlistId) {
    const alerts = [];
    // Get client's latest dossiers
    const dossiers = await prisma_1.default.dossier.findMany({
        where: { clientId },
        include: {
            exceptions: { where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } },
            scoring: true,
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
async function checkInternalDossierChanges(dossierId, watchlistId) {
    const alerts = [];
    // Get last known alert time for this watchlist
    const lastAlert = await prisma_1.default.watchlistAlert.findFirst({
        where: { watchlistId, entityId: dossierId },
        orderBy: { createdAt: 'desc' },
    });
    const since = lastAlert?.createdAt || new Date(Date.now() - 24 * 3600 * 1000);
    const dossier = await prisma_1.default.dossier.findUnique({
        where: { id: dossierId },
        include: {
            exceptions: { where: { createdAt: { gte: since } } },
            recherches: { where: { executedAt: { gte: since }, confidence: { gte: 0.7 } } },
        },
    });
    if (!dossier)
        return alerts;
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
        if (r.confidence >= 0.8 && r.matches && r.matches.length > 0) {
            alerts.push({
                type: `RECHERCHE_HIT_${r.type}`,
                severity: r.confidence >= 0.9 ? 'CRITICAL' : 'HIGH',
                title: `Correspondance ${r.type}: ${r.matches.length} résultat(s)`,
                description: `Confiance: ${(r.confidence * 100).toFixed(0)}%`,
                details: { rechercheId: r.id, type: r.type, confidence: r.confidence },
            });
        }
    }
    return alerts;
}
// ─── Get unread alerts ────────────────────────────────────────────────────────
async function getUnreadAlerts(userId) {
    const watchlists = await prisma_1.default.watchlist.findMany({
        where: { userId },
        select: { id: true },
    });
    return prisma_1.default.watchlistAlert.findMany({
        where: {
            watchlistId: { in: watchlists.map((w) => w.id) },
            isRead: false,
        },
        include: { watchlist: { select: { name: true, color: true } } },
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        take: 50,
    });
}
// ─── Mark alerts as read ─────────────────────────────────────────────────────
async function markAlertsRead(alertIds) {
    return prisma_1.default.watchlistAlert.updateMany({
        where: { id: { in: alertIds } },
        data: { isRead: true }
    });
}
// ─── Background job: check all active watchlists ─────────────────────────────
async function runAllWatchlistChecks() {
    const now = new Date();
    const toCheck = [];
    // Collect watchlists due for checking based on frequency
    const all = await prisma_1.default.watchlist.findMany({
        where: { isActive: true },
    });
    for (const wl of all) {
        const last = wl.lastCheckedAt ? new Date(wl.lastCheckedAt) : new Date(0);
        const elapsed = now.getTime() - last.getTime();
        const freq = wl.checkFrequency || 'DAILY';
        const threshold = freq === 'REALTIME' ? 5 * 60 * 1000 :
            freq === 'HOURLY' ? 60 * 60 * 1000 :
                freq === 'DAILY' ? 24 * 3600 * 1000 :
                    freq === 'WEEKLY' ? 7 * 24 * 3600 * 1000 :
                        24 * 3600 * 1000;
        if (elapsed >= threshold) {
            toCheck.push(wl);
        }
    }
    (0, logger_1.logSystemEvent)({
        action: 'watchlist_batch_check_start',
        component: 'watchlistService',
        details: { total: all.length, dueForCheck: toCheck.length },
        severity: 'info',
    });
    // Process sequentially to avoid rate-limiting external APIs
    for (const wl of toCheck) {
        try {
            await checkWatchlist(wl.id);
        }
        catch (e) {
            (0, logger_1.logSystemEvent)({
                action: 'watchlist_batch_check_error',
                component: 'watchlistService',
                details: { watchlistId: wl.id, error: String(e) },
                severity: 'error',
            });
        }
        // Small delay between watchlists to be respectful of APIs
        await new Promise(r => setTimeout(r, 2000));
    }
    (0, logger_1.logSystemEvent)({
        action: 'watchlist_batch_check_complete',
        component: 'watchlistService',
        details: { checked: toCheck.length },
        severity: 'info',
    });
}
// ─── Delete watchlist ─────────────────────────────────────────────────────────
async function deleteWatchlist(watchlistId, userId) {
    const wl = await prisma_1.default.watchlist.findFirst({
        where: { id: watchlistId, userId }
    });
    if (!wl)
        throw new Error('Watchlist introuvable ou accès refusé');
    await prisma_1.default.watchlistAlert.deleteMany({ where: { watchlistId } });
    return prisma_1.default.watchlist.delete({ where: { id: watchlistId } });
}
// ─── Get watchlist stats ──────────────────────────────────────────────────────
async function getWatchlistStats(userId) {
    const watchlists = await prisma_1.default.watchlist.findMany({
        where: { userId },
        include: { _count: { select: { alerts: true } } }
    });
    const totalEntities = watchlists.reduce((sum, wl) => sum + (wl.entities?.length || 0), 0);
    const totalAlerts = watchlists.reduce((sum, wl) => sum + wl._count.alerts, 0);
    const unreadAlerts = await prisma_1.default.watchlistAlert.count({
        where: {
            watchlistId: { in: watchlists.map((w) => w.id) },
            isRead: false,
        }
    });
    const criticalAlerts = await prisma_1.default.watchlistAlert.count({
        where: {
            watchlistId: { in: watchlists.map((w) => w.id) },
            severity: 'CRITICAL',
            isRead: false,
        }
    });
    return {
        totalWatchlists: watchlists.length,
        activeWatchlists: watchlists.filter((w) => w.isActive).length,
        totalEntities,
        totalAlerts,
        unreadAlerts,
        criticalAlerts,
    };
}
//# sourceMappingURL=watchlistService.js.map