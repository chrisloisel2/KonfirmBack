/**
 * Service de vérification des seuils LCB-FT selon règles GODECHOT PAULIET
 * Implémentation conforme au cahier des charges GODECHOT PAULIET
 */
export interface SeuilCheckResult {
    clientType: 'occasionnel' | 'relation_affaires';
    seuilApplicable: number;
    montantCumule12Mois: number;
    montantCumule4Semaines: number;
    requiredDialigences: string[];
    justification: string;
}
export interface GelAvoirsResult {
    isListed: boolean;
    matches?: Array<{
        name: string;
        details: string;
        listType: string;
    }>;
    confidence: number;
    checkedAt: Date;
    source: 'DG_TRESOR';
}
/**
 * Détermine le type de client et les seuils applicables
 * Règles GODECHOT PAULIET:
 * - Client occasionnel: primo-acheteur (aucun achat 12 mois glissants)
 * - Relation d'affaires: 2ème achat OU achat dans 12 mois précédents
 * - Transactions liées: 4 semaines glissantes (pas 12 mois)
 */
export declare function checkSeuilsLcbFt(numeroIdentite: string, montantTransaction: number, userId?: string): Promise<SeuilCheckResult>;
/**
 * Vérification spécifique gel des avoirs DG Trésor
 * URL: https://gels-avoirs.dgtresor.gouv.fr/List
 * Conforme aux procédures GODECHOT PAULIET section IV.j)
 */
export declare function checkGelAvoirsDGTresor(nomPrenom: string, userId?: string): Promise<GelAvoirsResult>;
/**
 * Surveillance vigilance constante pour relations d'affaires
 * Conforme aux procédures GODECHOT PAULIET section VI
 */
export declare function checkVigilanceConstante(clientId: string, userId?: string): Promise<{
    requiresUpdate: boolean;
    changes: Array<{
        type: string;
        description: string;
    }>;
    lastCheck: Date;
}>;
//# sourceMappingURL=seuilsLcbFtService.d.ts.map