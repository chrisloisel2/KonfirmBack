/**
 * Service TRACFIN - Déclarations de Soupçon Opérationnel (DSO)
 *
 * Conforme aux procédures GODECHOT PAULIET LCB-FT pour:
 * - Évaluation automatique du niveau de suspicion
 * - Génération de déclarations TRACFIN
 * - Interface avec la plateforme Ermès (simulation)
 * - Traçabilité complète des décisions
 *
 * Références réglementaires:
 * - Code monétaire et financier, art. L561-15 et suivants
 * - Arrêté du 2 juin 2021 relatif aux déclarations de soupçon
 * - Instructions TRACFIN pour les organismes assujettis
 */
export interface TracfinDeclaration {
    id: string;
    dossierId: string;
    clientInfo: {
        nom: string;
        prenom: string;
        dateNaissance: string;
        nationalite: string;
        adresse?: string;
    };
    operationInfo: {
        montant: number;
        devise: string;
        dateOperation: Date;
        natureSoupcon: string;
        description: string;
        moyenPaiement: string;
        origineGeographique?: string;
        beneficiaire?: string;
    };
    evaluationSoupcon: {
        score: number;
        criteres: string[];
        risqueIdentifie: 'FAIBLE' | 'MODÉRÉ' | 'ÉLEVÉ' | 'TRÈS_ÉLEVÉ';
        recommendationDSO: boolean;
    };
    status: 'BROUILLON' | 'EN_ATTENTE' | 'TRANSMISE' | 'ARCHIVÉE';
    metadata: {
        createdBy: string;
        createdAt: Date;
        lastModified: Date;
        ermesReference?: string;
    };
}
export interface SuspicionCriteria {
    code: string;
    libelle: string;
    poids: number;
    description: string;
    domaine: 'IDENTITÉ' | 'TRANSACTION' | 'COMPORTEMENT' | 'GÉOGRAPHIQUE' | 'TEMPOREL';
}
export declare const CRITERES_SUSPICION: SuspicionCriteria[];
/**
 * Évalue le niveau de suspicion d'une opération selon les critères GODECHOT PAULIET
 */
export declare function evaluateSuspicion(params: {
    montant: number;
    clientType: 'occasionnel' | 'relation_affaires';
    moyenPaiement: string;
    origineGeographique?: string;
    hasIdentityIssues: boolean;
    isPEP: boolean;
    hasSanctions: boolean;
    hasGelAvoirs: boolean;
    clientBehavior?: 'normal' | 'evasive' | 'suspicious';
    transactionFrequency?: number;
}): {
    score: number;
    criteres: SuspicionCriteria[];
    risque: 'FAIBLE' | 'MODÉRÉ' | 'ÉLEVÉ' | 'TRÈS_ÉLEVÉ';
    recommendDSO: boolean;
};
/**
 * Génère une déclaration TRACFIN pré-remplie
 */
export declare function generateTracfinDeclaration(params: {
    dossierId: string;
    clientInfo: TracfinDeclaration['clientInfo'];
    operationInfo: Omit<TracfinDeclaration['operationInfo'], 'natureSoupcon' | 'description'>;
    evaluationResult: ReturnType<typeof evaluateSuspicion>;
    createdBy: string;
}): TracfinDeclaration;
/**
 * Interface simulée avec la plateforme Ermès pour transmission TRACFIN
 * En production, ceci ferait appel à l'API réelle Ermès
 */
export declare function transmitToErmes(declaration: TracfinDeclaration): Promise<{
    success: boolean;
    ermesReference?: string;
    error?: string;
}>;
/**
 * Récupère l'historique des déclarations pour un client donné
 */
export declare function getDeclarationHistory(clientInfo: {
    nom: string;
    prenom: string;
    dateNaissance: string;
}): Promise<TracfinDeclaration[]>;
/**
 * Valide qu'une déclaration peut être transmise à TRACFIN
 */
export declare function validateDeclaration(declaration: TracfinDeclaration): {
    isValid: boolean;
    errors: string[];
};
declare const _default: {
    evaluateSuspicion: typeof evaluateSuspicion;
    generateTracfinDeclaration: typeof generateTracfinDeclaration;
    transmitToErmes: typeof transmitToErmes;
    getDeclarationHistory: typeof getDeclarationHistory;
    validateDeclaration: typeof validateDeclaration;
    CRITERES_SUSPICION: SuspicionCriteria[];
};
export default _default;
//# sourceMappingURL=tracfinService.d.ts.map