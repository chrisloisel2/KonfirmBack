/**
 * Universal Search Service
 *
 * Recherche full-text en temps réel sur l'intégralité de la base de données :
 *   - Clients (nom, prénom, email, téléphone, adresse, profession, employeur, n° identité)
 *   - Dossiers (numéro, notes, type, montant)
 *   - Documents (OCR text, nom de fichier)
 *   - Exceptions (description, résolution)
 *   - Déclarations TRACFIN (description, nature du soupçon)
 *   - Logs d'audit (action, ressource)
 *   - Recherches (query, résultats)
 *   - Scoring (justification, recommandation)
 *
 * Fonctionnalités :
 *   - Recherche par regex case-insensitive avec accents normalisés
 *   - Scoring de pertinence par entité
 *   - Facettes (count par type d'entité)
 *   - Pagination
 *   - Tri par pertinence ou date
 *   - Suggestions / autocomplete
 *   - Historique des recherches
 *   - Filtres avancés (50+ critères)
 */
export type EntityType = 'CLIENT' | 'DOSSIER' | 'DOCUMENT' | 'EXCEPTION' | 'TRACFIN' | 'AUDIT' | 'RECHERCHE' | 'SCORING';
export interface SearchResult {
    entityType: EntityType;
    entityId: string;
    score: number;
    highlight: Record<string, string>;
    data: Record<string, any>;
    dossierId?: string;
    dossierNumero?: string;
    clientName?: string;
}
export interface SearchFacets {
    CLIENT: number;
    DOSSIER: number;
    DOCUMENT: number;
    EXCEPTION: number;
    TRACFIN: number;
    AUDIT: number;
    RECHERCHE: number;
    SCORING: number;
}
export interface UniversalSearchOptions {
    query: string;
    entityTypes?: EntityType[];
    page?: number;
    limit?: number;
    sortBy?: 'relevance' | 'date' | 'risk';
    sortOrder?: 'asc' | 'desc';
    filters?: AdvancedFilters;
    userId?: string;
    userRole?: string;
}
export interface AdvancedFilters {
    dateFrom?: string;
    dateTo?: string;
    nationalite?: string[];
    profession?: string[];
    personnePublique?: boolean;
    revenus?: {
        min?: number;
        max?: number;
    };
    patrimoine?: {
        min?: number;
        max?: number;
    };
    pays?: string[];
    ville?: string;
    dossierStatus?: string[];
    typeOuverture?: string[];
    montant?: {
        min?: number;
        max?: number;
    };
    assignedToId?: string;
    createdById?: string;
    scoringNiveau?: string[];
    scoreRange?: {
        min?: number;
        max?: number;
    };
    exceptionType?: string[];
    exceptionStatus?: string[];
    exceptionPriority?: string[];
    documentType?: string[];
    documentVerified?: boolean;
    hasOcrText?: boolean;
    rechercheType?: string[];
    rechercheStatus?: string[];
    confidenceMin?: number;
    tracfinStatus?: string[];
    risqueLevel?: string[];
    auditAction?: string[];
    auditResource?: string;
    ipAddress?: string;
}
export interface UniversalSearchResponse {
    results: SearchResult[];
    total: number;
    totalByType: SearchFacets;
    page: number;
    pageSize: number;
    hasMore: boolean;
    query: string;
    durationMs: number;
    suggestions?: string[];
}
export declare function universalSearch(opts: UniversalSearchOptions): Promise<UniversalSearchResponse>;
export declare function generateSuggestions(query: string): Promise<string[]>;
export interface TimelineEvent {
    id: string;
    type: string;
    entityType: EntityType | 'SYSTEM';
    timestamp: Date;
    title: string;
    description: string;
    severity?: 'info' | 'warning' | 'error' | 'success';
    dossierId?: string;
    dossierNumero?: string;
    userId?: string;
    userName?: string;
    data?: any;
}
export declare function getEntityTimeline(opts: {
    clientId?: string;
    dossierId?: string;
    userId?: string;
    dateFrom?: string;
    dateTo?: string;
    types?: string[];
    limit?: number;
}): Promise<TimelineEvent[]>;
export declare function recordSearchHistory(userId: string, query: string, queryParams: any, response: UniversalSearchResponse): Promise<void>;
//# sourceMappingURL=universalSearchService.d.ts.map