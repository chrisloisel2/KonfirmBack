/**
 * OSINT Mega-Service — 25+ sources de renseignement
 *
 * Sources intégrées:
 *   SANCTIONS / PPE / GEL DES AVOIRS:
 *     1.  OpenSanctions (international, libre)
 *     2.  OFAC SDN — US Treasury (libre)
 *     3.  EU Financial Sanctions (europa.eu, libre)
 *     4.  UN Security Council Sanctions (libre)
 *     5.  UK HM Treasury Sanctions (libre)
 *     6.  DG Trésor Gel des Avoirs (France, scraping)
 *     7.  Swiss SECO Sanctions (libre)
 *     8.  Interpol Red Notices (API publique)
 *
 *   REGISTRES COMMERCIAUX / ENTREPRISES:
 *     9.  BODACC (Journal officiel des entreprises, libre)
 *     10. INPI / Pappers API (entreprises FR)
 *     11. INSEE SIRENE (libre)
 *     12. Infogreffe (scraping)
 *     13. OpenCorporates (international)
 *
 *   PRESSE / RÉPUTATION:
 *     14. Google News RSS
 *     15. Bing News RSS
 *     16. Le Monde RSS
 *     17. Le Figaro RSS
 *     18. BFM Business RSS
 *     19. AFP via scraping
 *     20. DuckDuckGo instant answers
 *
 *   JUSTICE / JUDICIAIRE:
 *     21. Légifrance (décisions de justice)
 *     22. Cour de Cassation (jurisprudence)
 *
 *   RISQUE PAYS / INTERNATIONAL:
 *     23. FATF country risk (scraping)
 *     24. Transparency International CPI (API)
 *     25. World Bank debarment list (libre)
 *
 *   RÉSEAUX SOCIAUX / WEB:
 *     26. Wikipedia (API publique)
 *     27. LinkedIn public (scraping limité)
 *
 *   BLOCKCHAIN / CRYPTO (red flags):
 *     28. Chainalysis exposure (si API key)
 */
export interface OsintQuery {
    nom: string;
    prenom?: string;
    dateNaissance?: string;
    nationalite?: string;
    pays?: string;
    entreprise?: string;
    siret?: string;
    type: 'PERSON' | 'COMPANY' | 'MIXED';
    confidenceThreshold?: number;
}
export interface OsintSource {
    id: string;
    label: string;
    category: OsintCategory;
    status: 'SUCCESS' | 'ERROR' | 'TIMEOUT' | 'SKIPPED' | 'NO_DATA';
    durationMs: number;
    matchCount: number;
    results: OsintMatch[];
    error?: string;
    url?: string;
}
export type OsintCategory = 'SANCTIONS' | 'PPE' | 'GEL_AVOIRS' | 'INTERPOL' | 'ENTREPRISE' | 'PRESSE' | 'JUDICIAIRE' | 'RISQUE_PAYS' | 'ENCYCLOPEDIQUE' | 'BLOCKCHAIN';
export interface OsintMatch {
    id: string;
    sourceId: string;
    name: string;
    aliases?: string[];
    matchScore: number;
    matchType: string;
    category: OsintCategory;
    details: Record<string, any>;
    url?: string;
    snippet?: string;
    dateFound?: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}
export interface OsintReport {
    query: OsintQuery;
    sources: OsintSource[];
    totalMatches: number;
    criticalMatches: OsintMatch[];
    highMatches: OsintMatch[];
    mediumMatches: OsintMatch[];
    lowMatches: OsintMatch[];
    overallRisk: 'AUCUN' | 'FAIBLE' | 'MOYEN' | 'ELEVE' | 'CRITIQUE';
    riskScore: number;
    summary: string;
    generatedAt: Date;
    durationMs: number;
}
export declare function runOsintMega(query: OsintQuery): Promise<OsintReport>;
export declare function runOsintQuick(query: OsintQuery): Promise<OsintReport>;
//# sourceMappingURL=osintMegaService.d.ts.map