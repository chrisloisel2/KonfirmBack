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
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=intelligence.d.ts.map