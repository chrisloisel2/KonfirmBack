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
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=search.d.ts.map