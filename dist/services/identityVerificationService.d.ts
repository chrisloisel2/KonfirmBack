/**
 * Identity Verification Service
 *
 * Runs parallel checks against open APIs and public sources:
 *   1. Document format & expiry (offline)
 *   2. OpenSanctions (sanctions + PEP, free 500 req/day)
 *   3. OFAC SDN (US Treasury, free)
 *   4. EU Financial Sanctions (europa.eu, free)
 *   5. Interpol Red Notices (public API, free)
 *   6. DuckDuckGo Instant Answer (reputation, free)
 *   7. Wikipedia PEP check (free API)
 *   8. Web Crawling multi-sources (Google News, BODACC, Bing, Qwant, Presse FR)
 *   9. Intelligence entreprises (INSEE/BODACC — évasion fiscale, phoenix, holding)
 */
export interface IdentityInput {
    nom: string;
    prenom: string;
    dateNaissance: string;
    nationalite: string;
    numeroDocument: string;
    dateExpiration: string;
    docType: 'cni' | 'passeport';
}
export type VerificationStatus = 'clear' | 'alert' | 'warning' | 'pending' | 'error';
export interface VerificationResult {
    id: string;
    source: string;
    sourceLabel: string;
    category: 'document' | 'sanctions' | 'pep' | 'reputation' | 'judicial';
    status: VerificationStatus;
    summary: string;
    details: string;
    confidence: number;
    url?: string;
    matches?: any[];
    checkedAt: Date;
}
export declare function verifyIdentity(input: IdentityInput): Promise<VerificationResult[]>;
/**
 * Effectue une vérification complète selon les procédures GODECHOT PAULIET LCB-FT
 * Inclut obligatoirement la vérification DG Trésor pour conformité réglementaire
 */
export declare function verifyIdentityLCBFT(input: IdentityInput): Promise<VerificationResult[]>;
//# sourceMappingURL=identityVerificationService.d.ts.map