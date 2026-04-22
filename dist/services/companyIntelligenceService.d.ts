/**
 * Company Intelligence Service — Détection de schémas d'évasion fiscale
 *
 * Sources:
 *   1. INSEE Recherche Entreprises (api.gouv.fr) — aucune clé, officiel
 *   2. BODACC (liquidations officielles)           — production seulement
 *   3. Société.com                                 — scraping HTML
 *
 * Patterns détectés:
 *   - Liquidations en série      : personne liée à 2+ entreprises liquidées
 *   - Entreprises "phoenix"      : nouvelle société créée après liquidation, même secteur
 *   - Réseau de sociétés-écrans  : holding + plusieurs filiales à la même adresse
 *   - Micro-entreprises multiples: 3+ EI actives = fractionnement de chiffre d'affaires
 *   - Durée de vie courte        : entreprises ouvertes < 2 ans puis fermées
 *   - Holding pure               : société 64.20Z sans salarié = optimisation agressive
 */
import type { IdentityInput, VerificationResult } from './identityVerificationService';
export interface CompanyRecord {
    name: string;
    siren?: string;
    siret?: string;
    status: 'active' | 'closed' | 'liquidation' | 'unknown';
    role?: string;
    dateCreation?: string;
    dateFermeture?: string;
    lifespanMonths?: number;
    activity?: string;
    activityLabel?: string;
    address?: string;
    city?: string;
    legalForm?: string;
    isHolding: boolean;
    isSoleTrader: boolean;
    source: string;
}
export type PatternType = 'serial_liquidation' | 'phoenix_company' | 'shell_network' | 'micro_split' | 'short_lived' | 'pure_holding';
export interface CompanyPattern {
    type: PatternType;
    severity: 'critical' | 'high' | 'medium';
    label: string;
    description: string;
    evidence: CompanyRecord[];
}
export declare function checkCompanyIntelligence(input: IdentityInput): Promise<VerificationResult>;
//# sourceMappingURL=companyIntelligenceService.d.ts.map