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
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=watchlists.d.ts.map