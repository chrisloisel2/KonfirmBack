/**
 * Batch Search Service — Recherche en Lot
 *
 * Traitement de fichiers CSV/JSON contenant plusieurs entités à vérifier:
 *   - Upload CSV (nom, prénom, date_naissance, nationalite, ...)
 *   - Vérification parallèle avec throttling (respecter les APIs)
 *   - Résultats agrégés par entité
 *   - Export CSV/JSON des résultats
 *   - Progression en temps réel
 *   - Résumé statistique
 */
export interface BatchRecord {
    rowIndex: number;
    nom: string;
    prenom?: string;
    dateNaissance?: string;
    nationalite?: string;
    pays?: string;
    entreprise?: string;
    siret?: string;
    reference?: string;
    notes?: string;
}
export interface BatchSearchOptions {
    records: BatchRecord[];
    searchTypes: ('PPE' | 'SANCTIONS' | 'GEL_AVOIRS' | 'INTERPOL' | 'PAYS_RISQUE' | 'PRESSE' | 'ENTREPRISE')[];
    confidenceThreshold?: number;
    concurrency?: number;
    name?: string;
    userId: string;
}
export interface BatchRecordResult {
    rowIndex: number;
    nom: string;
    prenom?: string;
    reference?: string;
    hasHit: boolean;
    riskLevel: 'AUCUN' | 'FAIBLE' | 'MOYEN' | 'ELEVE' | 'CRITIQUE';
    sanctionsHit: boolean;
    gelAvoirsHit: boolean;
    pepHit: boolean;
    interpolHit: boolean;
    paysRisqueHit: boolean;
    presseHit: boolean;
    matchCount: number;
    maxConfidence: number;
    topMatches: Array<{
        source: string;
        name: string;
        score: number;
        severity: string;
        snippet?: string;
    }>;
    durationMs: number;
    error?: string;
}
export interface BatchSearchResult {
    batchId: string;
    name: string;
    status: string;
    totalRecords: number;
    processedCount: number;
    hitCount: number;
    criticalCount: number;
    highCount: number;
    results: BatchRecordResult[];
    summary: BatchSummary;
    createdAt: Date;
    completedAt?: Date;
}
export interface BatchSummary {
    totalProcessed: number;
    totalHits: number;
    hitRate: string;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    byType: Record<string, number>;
    averageDurationMs: number;
    topRiskEntities: BatchRecordResult[];
}
export declare function parseCSVToRecords(csvContent: string): BatchRecord[];
export declare function runBatchSearch(opts: BatchSearchOptions): Promise<BatchSearchResult>;
export declare function exportBatchResultsToCSV(results: BatchRecordResult[]): string;
export declare function getBatchSearch(batchId: string, userId: string): Promise<any>;
export declare function getUserBatchSearches(userId: string): Promise<any>;
//# sourceMappingURL=batchSearchService.d.ts.map