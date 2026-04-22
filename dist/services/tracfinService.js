"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CRITERES_SUSPICION = void 0;
exports.evaluateSuspicion = evaluateSuspicion;
exports.generateTracfinDeclaration = generateTracfinDeclaration;
exports.transmitToErmes = transmitToErmes;
exports.getDeclarationHistory = getDeclarationHistory;
exports.validateDeclaration = validateDeclaration;
const logger_1 = require("../utils/logger");
// Critères de suspicion selon GODECHOT PAULIET
exports.CRITERES_SUSPICION = [
    // Critères identité
    {
        code: 'ID001',
        libelle: 'Identité douteuse ou incomplète',
        poids: 15,
        description: 'Documents falsifiés, incohérences dans les informations d\'identité',
        domaine: 'IDENTITÉ'
    },
    {
        code: 'ID002',
        libelle: 'PPE ou sanctions internationales',
        poids: 20,
        description: 'Personne politiquement exposée ou présente sur listes de sanctions',
        domaine: 'IDENTITÉ'
    },
    {
        code: 'ID003',
        libelle: 'Gel des avoirs DG Trésor',
        poids: 20,
        description: 'Personne inscrite sur le registre des gels d\'avoirs',
        domaine: 'IDENTITÉ'
    },
    // Critères transactionnels
    {
        code: 'TR001',
        libelle: 'Montant inhabituellement élevé',
        poids: 12,
        description: 'Transaction d\'un montant disproportionné par rapport au profil client',
        domaine: 'TRANSACTION'
    },
    {
        code: 'TR002',
        libelle: 'Structuration de transactions',
        poids: 18,
        description: 'Fractionnement apparent pour éviter les seuils de déclaration',
        domaine: 'TRANSACTION'
    },
    {
        code: 'TR003',
        libelle: 'Espèces importantes',
        poids: 14,
        description: 'Utilisation d\'espèces pour des montants élevés',
        domaine: 'TRANSACTION'
    },
    // Critères géographiques
    {
        code: 'GEO001',
        libelle: 'Pays à haut risque',
        poids: 16,
        description: 'Origine ou destination dans un pays à haut risque (GAFI)',
        domaine: 'GÉOGRAPHIQUE'
    },
    {
        code: 'GEO002',
        libelle: 'Paradis fiscal',
        poids: 14,
        description: 'Transactions impliquant des paradis fiscaux',
        domaine: 'GÉOGRAPHIQUE'
    },
    // Critères comportementaux
    {
        code: 'COMP001',
        libelle: 'Réticence à fournir des informations',
        poids: 10,
        description: 'Client évasif ou refusant de fournir des justificatifs',
        domaine: 'COMPORTEMENT'
    },
    {
        code: 'COMP002',
        libelle: 'Changement soudain de comportement',
        poids: 8,
        description: 'Modification importante et inexpliquée du profil transactionnel',
        domaine: 'COMPORTEMENT'
    },
    // Critères temporels
    {
        code: 'TEMP001',
        libelle: 'Fréquence anormale',
        poids: 12,
        description: 'Transactions répétées dans un laps de temps très court',
        domaine: 'TEMPOREL'
    }
];
/**
 * Évalue le niveau de suspicion d'une opération selon les critères GODECHOT PAULIET
 */
function evaluateSuspicion(params) {
    const criteresDetectes = [];
    let scoreTotal = 0;
    // Vérification des critères identité
    if (params.hasIdentityIssues) {
        const critere = exports.CRITERES_SUSPICION.find(c => c.code === 'ID001');
        if (critere) {
            criteresDetectes.push(critere);
            scoreTotal += critere.poids;
        }
    }
    if (params.isPEP) {
        const critere = exports.CRITERES_SUSPICION.find(c => c.code === 'ID002');
        if (critere) {
            criteresDetectes.push(critere);
            scoreTotal += critere.poids;
        }
    }
    if (params.hasGelAvoirs) {
        const critere = exports.CRITERES_SUSPICION.find(c => c.code === 'ID003');
        if (critere) {
            criteresDetectes.push(critere);
            scoreTotal += critere.poids;
        }
    }
    // Vérification des critères transactionnels
    const seuilEleveMontant = params.clientType === 'occasionnel' ? 15000 : 10000;
    if (params.montant > seuilEleveMontant * 2) { // 2x le seuil = montant inhabituellement élevé
        const critere = exports.CRITERES_SUSPICION.find(c => c.code === 'TR001');
        if (critere) {
            criteresDetectes.push(critere);
            scoreTotal += critere.poids;
        }
    }
    if (params.moyenPaiement === 'especes' && params.montant > 3000) {
        const critere = exports.CRITERES_SUSPICION.find(c => c.code === 'TR003');
        if (critere) {
            criteresDetectes.push(critere);
            scoreTotal += critere.poids;
        }
    }
    // Vérification des critères géographiques
    const PAYS_HAUT_RISQUE = ['AF', 'KP', 'IR', 'SY', 'MM', 'YE', 'LY', 'SO', 'IQ', 'SD'];
    const PARADIS_FISCAUX = ['KY', 'BM', 'JE', 'GG', 'IM', 'MC', 'LI', 'AD', 'SM', 'MT'];
    if (params.origineGeographique) {
        if (PAYS_HAUT_RISQUE.includes(params.origineGeographique)) {
            const critere = exports.CRITERES_SUSPICION.find(c => c.code === 'GEO001');
            if (critere) {
                criteresDetectes.push(critere);
                scoreTotal += critere.poids;
            }
        }
        if (PARADIS_FISCAUX.includes(params.origineGeographique)) {
            const critere = exports.CRITERES_SUSPICION.find(c => c.code === 'GEO002');
            if (critere) {
                criteresDetectes.push(critere);
                scoreTotal += critere.poids;
            }
        }
    }
    // Vérification des critères comportementaux
    if (params.clientBehavior === 'evasive' || params.clientBehavior === 'suspicious') {
        const critere = exports.CRITERES_SUSPICION.find(c => c.code === 'COMP001');
        if (critere) {
            criteresDetectes.push(critere);
            scoreTotal += critere.poids;
        }
    }
    // Vérification des critères temporels
    if (params.transactionFrequency && params.transactionFrequency > 5) { // Plus de 5 transactions en 7 jours
        const critere = exports.CRITERES_SUSPICION.find(c => c.code === 'TEMP001');
        if (critere) {
            criteresDetectes.push(critere);
            scoreTotal += critere.poids;
        }
    }
    // Détermination du niveau de risque
    let risque;
    let recommendDSO = false;
    if (scoreTotal >= 35) {
        risque = 'TRÈS_ÉLEVÉ';
        recommendDSO = true;
    }
    else if (scoreTotal >= 25) {
        risque = 'ÉLEVÉ';
        recommendDSO = true;
    }
    else if (scoreTotal >= 15) {
        risque = 'MODÉRÉ';
        recommendDSO = false; // Surveillance renforcée mais pas de DSO automatique
    }
    else {
        risque = 'FAIBLE';
        recommendDSO = false;
    }
    // DSO obligatoire pour certains critères critiques
    if (params.hasGelAvoirs || params.hasSanctions) {
        recommendDSO = true;
        risque = 'TRÈS_ÉLEVÉ';
    }
    return {
        score: scoreTotal,
        criteres: criteresDetectes,
        risque,
        recommendDSO
    };
}
/**
 * Génère une déclaration TRACFIN pré-remplie
 */
function generateTracfinDeclaration(params) {
    const { evaluationResult } = params;
    // Génération automatique de la description du soupçon
    const description = generateSuspicionDescription(evaluationResult.criteres, params.operationInfo);
    const declaration = {
        id: `DSO-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        dossierId: params.dossierId,
        clientInfo: params.clientInfo,
        operationInfo: {
            ...params.operationInfo,
            natureSoupcon: evaluationResult.criteres.map(c => c.libelle).join(' | '),
            description
        },
        evaluationSoupcon: {
            score: evaluationResult.score,
            criteres: evaluationResult.criteres.map(c => c.libelle),
            risqueIdentifie: evaluationResult.risque,
            recommendationDSO: evaluationResult.recommendDSO
        },
        status: 'BROUILLON',
        metadata: {
            createdBy: params.createdBy,
            createdAt: new Date(),
            lastModified: new Date()
        }
    };
    (0, logger_1.logSystemEvent)({
        action: 'tracfin_declaration_generated',
        component: 'tracfinService',
        details: {
            declarationId: declaration.id,
            dossierId: params.dossierId,
            score: evaluationResult.score,
            risque: evaluationResult.risque,
            recommendDSO: evaluationResult.recommendDSO,
            criteresCount: evaluationResult.criteres.length
        },
        severity: evaluationResult.recommendDSO ? 'warning' : 'info'
    });
    return declaration;
}
/**
 * Génère une description textuelle du soupçon basée sur les critères détectés
 */
function generateSuspicionDescription(criteres, operation) {
    if (criteres.length === 0) {
        return 'Évaluation automatique - aucun critère de suspicion majeur détecté.';
    }
    const descriptions = criteres.map(c => c.description);
    const intro = `Opération présentant ${criteres.length} critère(s) de suspicion identifié(s) :`;
    let detail = `\n\nDétails de l'opération :\n`;
    detail += `- Montant : ${operation.montant} ${operation.devise}\n`;
    detail += `- Moyen de paiement : ${operation.moyenPaiement}\n`;
    detail += `- Date : ${operation.dateOperation.toLocaleDateString('fr-FR')}\n`;
    if (operation.origineGeographique) {
        detail += `- Origine géographique : ${operation.origineGeographique}\n`;
    }
    return intro + '\n' + descriptions.map((d, i) => `${i + 1}. ${d}`).join('\n') + detail;
}
/**
 * Interface simulée avec la plateforme Ermès pour transmission TRACFIN
 * En production, ceci ferait appel à l'API réelle Ermès
 */
async function transmitToErmes(declaration) {
    try {
        // Simulation de l'appel à Ermès
        (0, logger_1.logSystemEvent)({
            action: 'ermes_transmission_start',
            component: 'tracfinService',
            details: {
                declarationId: declaration.id,
                dossierId: declaration.dossierId,
                score: declaration.evaluationSoupcon.score
            },
            severity: 'info'
        });
        // En production: appel réel à l'API Ermès
        // const response = await axios.post('https://ermes.tracfin.gouv.fr/api/declarations', declaration);
        // Simulation d'une réponse positive après 2 secondes
        await new Promise(resolve => setTimeout(resolve, 2000));
        const ermesReference = `ERMES-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        (0, logger_1.logSystemEvent)({
            action: 'ermes_transmission_success',
            component: 'tracfinService',
            details: {
                declarationId: declaration.id,
                ermesReference,
                transmissionDate: new Date().toISOString()
            },
            severity: 'info'
        });
        return {
            success: true,
            ermesReference
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
        (0, logger_1.logSystemEvent)({
            action: 'ermes_transmission_error',
            component: 'tracfinService',
            details: {
                declarationId: declaration.id,
                error: errorMessage
            },
            severity: 'error'
        });
        return {
            success: false,
            error: errorMessage
        };
    }
}
/**
 * Récupère l'historique des déclarations pour un client donné
 */
async function getDeclarationHistory(clientInfo) {
    // En production, ceci interrogerait la base de données
    // pour récupérer toutes les déclarations antérieures du client
    (0, logger_1.logSystemEvent)({
        action: 'declaration_history_request',
        component: 'tracfinService',
        details: {
            clientNom: clientInfo.nom,
            clientPrenom: clientInfo.prenom
        },
        severity: 'info'
    });
    // Simulation - en réalité il faudrait interroger la BDD
    return [];
}
/**
 * Valide qu'une déclaration peut être transmise à TRACFIN
 */
function validateDeclaration(declaration) {
    const errors = [];
    // Validation des champs obligatoires
    if (!declaration.clientInfo.nom)
        errors.push('Nom du client manquant');
    if (!declaration.clientInfo.prenom)
        errors.push('Prénom du client manquant');
    if (!declaration.clientInfo.dateNaissance)
        errors.push('Date de naissance manquante');
    if (!declaration.clientInfo.nationalite)
        errors.push('Nationalité manquante');
    if (!declaration.operationInfo.montant || declaration.operationInfo.montant <= 0) {
        errors.push('Montant de l\'opération invalide');
    }
    if (!declaration.operationInfo.description)
        errors.push('Description du soupçon manquante');
    if (!declaration.operationInfo.natureSoupcon)
        errors.push('Nature du soupçon manquante');
    if (declaration.evaluationSoupcon.score < 15) {
        errors.push('Score de suspicion insuffisant pour une déclaration TRACFIN');
    }
    return {
        isValid: errors.length === 0,
        errors
    };
}
exports.default = {
    evaluateSuspicion,
    generateTracfinDeclaration,
    transmitToErmes,
    getDeclarationHistory,
    validateDeclaration,
    CRITERES_SUSPICION: exports.CRITERES_SUSPICION
};
//# sourceMappingURL=tracfinService.js.map