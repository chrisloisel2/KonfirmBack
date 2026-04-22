/**
 * Web Reputation & Crawling Service
 *
 * Searches 6 public sources for negative exposure:
 *   1. Google News RSS  — 3 requêtes ciblées (fraude, judiciaire, contrefaçon)
 *   2. BODACC           — Annonces officielles FR (liquidation, redressement)
 *   3. Bing News        — Scraping actualités
 *   4. DuckDuckGo HTML  — Résultats web réels (pas seulement Instant API)
 *   5. Presse française — Le Monde, France Info, 20 Minutes
 *   6. Pappers.fr       — Procédures judiciaires entreprises (optionnel, PAPPERS_API_KEY)
 */
import type { IdentityInput, VerificationResult } from './identityVerificationService';
export interface WebHit {
    source: string;
    title: string;
    url: string;
    snippet: string;
    date?: string;
    keywords: string[];
    severity: 'critical' | 'high' | 'medium' | 'low';
}
export declare function checkWebReputation(input: IdentityInput): Promise<VerificationResult>;
//# sourceMappingURL=webReputationService.d.ts.map