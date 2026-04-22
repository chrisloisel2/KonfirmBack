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
export declare function createWatchlist(userId: string, name: string, description: string | undefined, entities: WatchlistEntity[], checkFrequency?: string, color?: string): Promise<any>;
export declare function getUserWatchlists(userId: string): Promise<any>;
export declare function addEntityToWatchlist(watchlistId: string, entity: WatchlistEntity): Promise<any>;
export declare function removeEntityFromWatchlist(watchlistId: string, entityNom: string): Promise<any>;
export declare function checkWatchlist(watchlistId: string): Promise<WatchlistCheckResult[]>;
export declare function getUnreadAlerts(userId: string): Promise<any>;
export declare function markAlertsRead(alertIds: string[]): Promise<any>;
export declare function runAllWatchlistChecks(): Promise<void>;
export declare function deleteWatchlist(watchlistId: string, userId: string): Promise<any>;
export declare function getWatchlistStats(userId: string): Promise<{
    totalWatchlists: any;
    activeWatchlists: any;
    totalEntities: any;
    totalAlerts: any;
    unreadAlerts: any;
    criticalAlerts: any;
}>;
//# sourceMappingURL=watchlistService.d.ts.map