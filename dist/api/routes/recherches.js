"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../../lib/prisma"));
const axios_1 = __importDefault(require("axios"));
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const logger_1 = require("../../utils/logger");
const router = (0, express_1.Router)();
// Configuration des APIs externes
const API_CONFIG = {
    PPE: {
        url: process.env.PPE_API_URL || 'https://api.example.com/ppe',
        key: process.env.PPE_API_KEY || 'demo-key',
        timeout: 30000
    },
    SANCTIONS: {
        url: process.env.SANCTIONS_API_URL || 'https://api.example.com/sanctions',
        key: process.env.SANCTIONS_API_KEY || 'demo-key',
        timeout: 30000
    },
    ASSET_FREEZE: {
        url: process.env.ASSET_FREEZE_API_URL || 'https://api.example.com/assetfreeze',
        key: process.env.ASSET_FREEZE_API_KEY || 'demo-key',
        timeout: 30000
    }
};
// Validation schemas
const searchParamsSchema = zod_1.z.object({
    firstName: zod_1.z.string().min(1, 'Prénom requis'),
    lastName: zod_1.z.string().min(1, 'Nom requis'),
    dateOfBirth: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date de naissance invalide (YYYY-MM-DD)').optional(),
    nationality: zod_1.z.string().optional(),
    placeOfBirth: zod_1.z.string().optional(),
    fuzzyMatch: zod_1.z.boolean().default(true),
    confidenceThreshold: zod_1.z.number().min(0).max(1).default(0.7)
});
// Fonction générique pour les appels API externes
async function callExternalAPI(type, searchParams, dossierId) {
    const config = API_CONFIG[type];
    try {
        const requestData = {
            query: {
                firstName: searchParams.firstName,
                lastName: searchParams.lastName,
                dateOfBirth: searchParams.dateOfBirth,
                nationality: searchParams.nationality,
                placeOfBirth: searchParams.placeOfBirth
            },
            options: {
                fuzzyMatch: searchParams.fuzzyMatch,
                confidenceThreshold: searchParams.confidenceThreshold
            }
        };
        (0, logger_1.logSystemEvent)({
            action: 'external_api_request',
            component: `api_${type.toLowerCase()}`,
            details: {
                dossierId,
                requestData: { ...requestData, apiKey: '[HIDDEN]' }
            },
            severity: 'info'
        });
        const response = await axios_1.default.post(config.url, requestData, {
            headers: {
                'Authorization': `Bearer ${config.key}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Konfirm-LCB-FT/1.0'
            },
            timeout: config.timeout
        });
        // Simulation d'une réponse API (à adapter selon les vraies APIs)
        const mockResponse = generateMockResponse(type, searchParams);
        (0, logger_1.logSystemEvent)({
            action: 'external_api_response',
            component: `api_${type.toLowerCase()}`,
            details: {
                dossierId,
                statusCode: response.status,
                hasMatches: mockResponse.matches.length > 0,
                matchCount: mockResponse.matches.length
            },
            severity: 'info'
        });
        return {
            success: true,
            data: mockResponse.data,
            matches: mockResponse.matches,
            confidence: mockResponse.confidence,
            apiProvider: `API_${type}`
        };
    }
    catch (error) {
        let errorMessage = 'Erreur inconnue';
        let statusCode = 0;
        if (axios_1.default.isAxiosError(error)) {
            errorMessage = error.response?.data?.message || error.message;
            statusCode = error.response?.status || 0;
        }
        else if (error instanceof Error) {
            errorMessage = error.message;
        }
        (0, logger_1.logSystemEvent)({
            action: 'external_api_error',
            component: `api_${type.toLowerCase()}`,
            details: {
                dossierId,
                error: errorMessage,
                statusCode,
                timeout: config.timeout
            },
            severity: 'error'
        });
        return {
            success: false,
            error: errorMessage,
            apiProvider: `API_${type}`
        };
    }
}
// Génération de réponses mock pour les tests (à remplacer par les vraies APIs)
function generateMockResponse(type, searchParams) {
    // Simulation de correspondances pour certains noms de test
    const testMatches = {
        'dupont': {
            PPE: [
                {
                    id: 'ppe-001',
                    name: 'Jean DUPONT',
                    positions: ['Maire de Exemple-Ville'],
                    country: 'France',
                    confidence: 0.95,
                    source: 'Official PEP List'
                }
            ],
            SANCTIONS: [],
            ASSET_FREEZE: []
        },
        'putin': {
            PPE: [
                {
                    id: 'ppe-002',
                    name: 'Vladimir PUTIN',
                    positions: ['President'],
                    country: 'Russia',
                    confidence: 0.99,
                    source: 'PEP Database'
                }
            ],
            SANCTIONS: [
                {
                    id: 'sanctions-001',
                    name: 'Vladimir PUTIN',
                    reason: 'Political sanctions',
                    dateAdded: '2022-02-24',
                    confidence: 0.99,
                    source: 'EU Sanctions List'
                }
            ],
            ASSET_FREEZE: [
                {
                    id: 'freeze-001',
                    name: 'Vladimir PUTIN',
                    regime: 'EU Asset Freeze',
                    dateAdded: '2022-02-24',
                    confidence: 0.99,
                    source: 'EU Asset Freeze List'
                }
            ]
        }
    };
    const lastName = searchParams.lastName.toLowerCase();
    const matches = (testMatches[lastName]?.[type] || []);
    return {
        data: {
            searchId: `search-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            query: searchParams,
            totalMatches: matches.length
        },
        matches,
        confidence: matches.length > 0 ? Math.max(...matches.map((m) => m.confidence)) : 0
    };
}
// POST /api/recherches/dossiers/:dossierId/ppe - Recherche PPE
router.post('/dossiers/:dossierId/ppe', auth_1.authenticateToken, auth_1.requireDossierAccess, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { dossierId } = req.params;
    const searchParams = searchParamsSchema.parse(req.body);
    const userId = req.user.id;
    // Création de l'enregistrement de recherche
    const recherche = await prisma_1.default.recherche.create({
        data: {
            dossierId,
            type: 'PPE',
            query: searchParams,
            status: 'EN_COURS'
        }
    });
    try {
        // Appel à l'API PPE
        const result = await callExternalAPI('PPE', searchParams, dossierId);
        // Mise à jour avec les résultats
        const updatedRecherche = await prisma_1.default.recherche.update({
            where: { id: recherche.id },
            data: {
                response: result.data,
                matches: result.matches,
                confidence: result.confidence,
                status: result.success ? 'TERMINE' : 'ERREUR',
                error: result.error,
                apiProvider: result.apiProvider,
                completedAt: new Date()
            }
        });
        // Vérification si des correspondances nécessitent une exception
        if (result.success && result.matches && result.matches.length > 0) {
            const highConfidenceMatches = result.matches.filter(match => match.confidence >= searchParams.confidenceThreshold);
            if (highConfidenceMatches.length > 0) {
                // Création d'une exception pour validation manuelle
                await prisma_1.default.exception.create({
                    data: {
                        dossierId,
                        type: 'PPE_DETECTION',
                        description: `Correspondance(s) PPE détectée(s) : ${highConfidenceMatches.map(m => m.name).join(', ')}`,
                        details: {
                            rechercheId: recherche.id,
                            matches: highConfidenceMatches,
                            searchParams
                        },
                        priority: 'HAUTE',
                        status: 'EN_ATTENTE'
                    }
                });
                (0, logger_1.logRechercheEvent)({
                    action: 'ppe_match_detected',
                    dossierId,
                    userId,
                    rechercheId: recherche.id,
                    details: {
                        matchCount: highConfidenceMatches.length,
                        maxConfidence: Math.max(...highConfidenceMatches.map(m => m.confidence)),
                        names: highConfidenceMatches.map(m => m.name)
                    }
                });
            }
        }
        (0, logger_1.logRechercheEvent)({
            action: 'ppe_search_completed',
            dossierId,
            userId,
            rechercheId: recherche.id,
            details: {
                success: result.success,
                matchCount: result.matches?.length || 0,
                confidence: result.confidence,
                duration: Date.now() - recherche.executedAt.getTime()
            }
        });
        (0, logger_1.logAuditEvent)({
            userId,
            action: 'CREATE',
            resource: 'recherche_ppe',
            resourceId: recherche.id,
            newValues: updatedRecherche,
            ipAddress: req.ip,
            metadata: { dossierId }
        });
        res.json({
            success: true,
            data: { recherche: updatedRecherche }
        });
    }
    catch (error) {
        // Mise à jour en cas d'erreur
        await prisma_1.default.recherche.update({
            where: { id: recherche.id },
            data: {
                status: 'ERREUR',
                error: error instanceof Error ? error.message : 'Erreur inconnue',
                completedAt: new Date()
            }
        });
        throw error;
    }
}));
// POST /api/recherches/dossiers/:dossierId/sanctions - Recherche sanctions
router.post('/dossiers/:dossierId/sanctions', auth_1.authenticateToken, auth_1.requireDossierAccess, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { dossierId } = req.params;
    const searchParams = searchParamsSchema.parse(req.body);
    const userId = req.user.id;
    const recherche = await prisma_1.default.recherche.create({
        data: {
            dossierId,
            type: 'SANCTIONS',
            query: searchParams,
            status: 'EN_COURS'
        }
    });
    try {
        const result = await callExternalAPI('SANCTIONS', searchParams, dossierId);
        const updatedRecherche = await prisma_1.default.recherche.update({
            where: { id: recherche.id },
            data: {
                response: result.data,
                matches: result.matches,
                confidence: result.confidence,
                status: result.success ? 'TERMINE' : 'ERREUR',
                error: result.error,
                apiProvider: result.apiProvider,
                completedAt: new Date()
            }
        });
        if (result.success && result.matches && result.matches.length > 0) {
            const highConfidenceMatches = result.matches.filter(match => match.confidence >= searchParams.confidenceThreshold);
            if (highConfidenceMatches.length > 0) {
                await prisma_1.default.exception.create({
                    data: {
                        dossierId,
                        type: 'SANCTIONS_DETECTION',
                        description: `Correspondance(s) sanctions détectée(s) : ${highConfidenceMatches.map(m => m.name).join(', ')}`,
                        details: {
                            rechercheId: recherche.id,
                            matches: highConfidenceMatches,
                            searchParams
                        },
                        priority: 'CRITIQUE',
                        status: 'EN_ATTENTE'
                    }
                });
                (0, logger_1.logRechercheEvent)({
                    action: 'sanctions_match_detected',
                    dossierId,
                    userId,
                    rechercheId: recherche.id,
                    details: {
                        matchCount: highConfidenceMatches.length,
                        maxConfidence: Math.max(...highConfidenceMatches.map(m => m.confidence)),
                        names: highConfidenceMatches.map(m => m.name)
                    }
                });
            }
        }
        (0, logger_1.logRechercheEvent)({
            action: 'sanctions_search_completed',
            dossierId,
            userId,
            rechercheId: recherche.id,
            details: {
                success: result.success,
                matchCount: result.matches?.length || 0,
                confidence: result.confidence
            }
        });
        res.json({
            success: true,
            data: { recherche: updatedRecherche }
        });
    }
    catch (error) {
        await prisma_1.default.recherche.update({
            where: { id: recherche.id },
            data: {
                status: 'ERREUR',
                error: error instanceof Error ? error.message : 'Erreur inconnue',
                completedAt: new Date()
            }
        });
        throw error;
    }
}));
// POST /api/recherches/dossiers/:dossierId/asset-freeze - Recherche gel des avoirs
router.post('/dossiers/:dossierId/asset-freeze', auth_1.authenticateToken, auth_1.requireDossierAccess, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { dossierId } = req.params;
    const searchParams = searchParamsSchema.parse(req.body);
    const userId = req.user.id;
    const recherche = await prisma_1.default.recherche.create({
        data: {
            dossierId,
            type: 'ASSET_FREEZE',
            query: searchParams,
            status: 'EN_COURS'
        }
    });
    try {
        const result = await callExternalAPI('ASSET_FREEZE', searchParams, dossierId);
        const updatedRecherche = await prisma_1.default.recherche.update({
            where: { id: recherche.id },
            data: {
                response: result.data,
                matches: result.matches,
                confidence: result.confidence,
                status: result.success ? 'TERMINE' : 'ERREUR',
                error: result.error,
                apiProvider: result.apiProvider,
                completedAt: new Date()
            }
        });
        if (result.success && result.matches && result.matches.length > 0) {
            const highConfidenceMatches = result.matches.filter(match => match.confidence >= searchParams.confidenceThreshold);
            if (highConfidenceMatches.length > 0) {
                await prisma_1.default.exception.create({
                    data: {
                        dossierId,
                        type: 'ASSET_FREEZE_DETECTION',
                        description: `Correspondance(s) gel des avoirs détectée(s) : ${highConfidenceMatches.map(m => m.name).join(', ')}`,
                        details: {
                            rechercheId: recherche.id,
                            matches: highConfidenceMatches,
                            searchParams
                        },
                        priority: 'CRITIQUE',
                        status: 'EN_ATTENTE'
                    }
                });
                (0, logger_1.logRechercheEvent)({
                    action: 'asset_freeze_match_detected',
                    dossierId,
                    userId,
                    rechercheId: recherche.id,
                    details: {
                        matchCount: highConfidenceMatches.length,
                        maxConfidence: Math.max(...highConfidenceMatches.map(m => m.confidence)),
                        names: highConfidenceMatches.map(m => m.name)
                    }
                });
            }
        }
        (0, logger_1.logRechercheEvent)({
            action: 'asset_freeze_search_completed',
            dossierId,
            userId,
            rechercheId: recherche.id,
            details: {
                success: result.success,
                matchCount: result.matches?.length || 0,
                confidence: result.confidence
            }
        });
        res.json({
            success: true,
            data: { recherche: updatedRecherche }
        });
    }
    catch (error) {
        await prisma_1.default.recherche.update({
            where: { id: recherche.id },
            data: {
                status: 'ERREUR',
                error: error instanceof Error ? error.message : 'Erreur inconnue',
                completedAt: new Date()
            }
        });
        throw error;
    }
}));
// POST /api/recherches/dossiers/:dossierId/complete - Recherche complète (PPE + Sanctions + Asset Freeze)
router.post('/dossiers/:dossierId/complete', auth_1.authenticateToken, auth_1.requireDossierAccess, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { dossierId } = req.params;
    const searchParams = searchParamsSchema.parse(req.body);
    const userId = req.user.id;
    // Lancement des 3 recherches en parallèle
    const recherches = await Promise.all([
        prisma_1.default.recherche.create({
            data: { dossierId, type: 'PPE', query: searchParams, status: 'EN_COURS' }
        }),
        prisma_1.default.recherche.create({
            data: { dossierId, type: 'SANCTIONS', query: searchParams, status: 'EN_COURS' }
        }),
        prisma_1.default.recherche.create({
            data: { dossierId, type: 'ASSET_FREEZE', query: searchParams, status: 'EN_COURS' }
        })
    ]);
    const [ppeRecherche, sanctionsRecherche, assetFreezeRecherche] = recherches;
    try {
        // Exécution des 3 recherches en parallèle
        const [ppeResult, sanctionsResult, assetFreezeResult] = await Promise.all([
            callExternalAPI('PPE', searchParams, dossierId),
            callExternalAPI('SANCTIONS', searchParams, dossierId),
            callExternalAPI('ASSET_FREEZE', searchParams, dossierId)
        ]);
        // Mise à jour des résultats
        const updatedRecherches = await Promise.all([
            prisma_1.default.recherche.update({
                where: { id: ppeRecherche.id },
                data: {
                    response: ppeResult.data,
                    matches: ppeResult.matches,
                    confidence: ppeResult.confidence,
                    status: ppeResult.success ? 'TERMINE' : 'ERREUR',
                    error: ppeResult.error,
                    apiProvider: ppeResult.apiProvider,
                    completedAt: new Date()
                }
            }),
            prisma_1.default.recherche.update({
                where: { id: sanctionsRecherche.id },
                data: {
                    response: sanctionsResult.data,
                    matches: sanctionsResult.matches,
                    confidence: sanctionsResult.confidence,
                    status: sanctionsResult.success ? 'TERMINE' : 'ERREUR',
                    error: sanctionsResult.error,
                    apiProvider: sanctionsResult.apiProvider,
                    completedAt: new Date()
                }
            }),
            prisma_1.default.recherche.update({
                where: { id: assetFreezeRecherche.id },
                data: {
                    response: assetFreezeResult.data,
                    matches: assetFreezeResult.matches,
                    confidence: assetFreezeResult.confidence,
                    status: assetFreezeResult.success ? 'TERMINE' : 'ERREUR',
                    error: assetFreezeResult.error,
                    apiProvider: assetFreezeResult.apiProvider,
                    completedAt: new Date()
                }
            })
        ]);
        // Gestion des exceptions
        const allMatches = [
            ...(ppeResult.matches || []).map(m => ({ ...m, type: 'PPE' })),
            ...(sanctionsResult.matches || []).map(m => ({ ...m, type: 'SANCTIONS' })),
            ...(assetFreezeResult.matches || []).map(m => ({ ...m, type: 'ASSET_FREEZE' }))
        ];
        const highConfidenceMatches = allMatches.filter(match => match.confidence >= searchParams.confidenceThreshold);
        if (highConfidenceMatches.length > 0) {
            // Création d'une exception globale
            await prisma_1.default.exception.create({
                data: {
                    dossierId,
                    type: 'VERIFICATION_MANUELLE',
                    description: `Correspondances détectées lors des vérifications LCB-FT`,
                    details: {
                        rechercheIds: recherches.map(r => r.id),
                        matches: highConfidenceMatches,
                        searchParams,
                        summary: {
                            ppe: (ppeResult.matches || []).length,
                            sanctions: (sanctionsResult.matches || []).length,
                            assetFreeze: (assetFreezeResult.matches || []).length
                        }
                    },
                    priority: highConfidenceMatches.some(m => m.type === 'SANCTIONS' || m.type === 'ASSET_FREEZE')
                        ? 'CRITIQUE'
                        : 'HAUTE',
                    status: 'EN_ATTENTE'
                }
            });
        }
        (0, logger_1.logRechercheEvent)({
            action: 'complete_search_finished',
            dossierId,
            userId,
            rechercheId: 'bulk',
            details: {
                totalMatches: allMatches.length,
                highConfidenceMatches: highConfidenceMatches.length,
                ppeMatches: (ppeResult.matches || []).length,
                sanctionsMatches: (sanctionsResult.matches || []).length,
                assetFreezeMatches: (assetFreezeResult.matches || []).length
            }
        });
        res.json({
            success: true,
            data: {
                recherches: updatedRecherches,
                summary: {
                    totalMatches: allMatches.length,
                    highConfidenceMatches: highConfidenceMatches.length,
                    requiresManualReview: highConfidenceMatches.length > 0
                }
            }
        });
    }
    catch (error) {
        // Mise en erreur de toutes les recherches
        await Promise.all(recherches.map(r => prisma_1.default.recherche.update({
            where: { id: r.id },
            data: {
                status: 'ERREUR',
                error: error instanceof Error ? error.message : 'Erreur inconnue',
                completedAt: new Date()
            }
        })));
        throw error;
    }
}));
// GET /api/recherches/dossiers/:dossierId - Historique des recherches d'un dossier
router.get('/dossiers/:dossierId', auth_1.authenticateToken, auth_1.requireDossierAccess, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { dossierId } = req.params;
    const recherches = await prisma_1.default.recherche.findMany({
        where: { dossierId },
        orderBy: { executedAt: 'desc' }
    });
    res.json({
        success: true,
        data: { recherches }
    });
}));
// GET /api/recherches/:rechercheId - Détails d'une recherche
router.get('/:rechercheId', auth_1.authenticateToken, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { rechercheId } = req.params;
    const recherche = await prisma_1.default.recherche.findUnique({
        where: { id: rechercheId },
        include: {
            dossier: {
                select: {
                    id: true,
                    numero: true,
                    createdById: true,
                    assignedToId: true
                }
            }
        }
    });
    if (!recherche) {
        throw new errorHandler_1.ValidationError('Recherche non trouvée');
    }
    // Vérification des permissions sur le dossier
    const userId = req.user.id;
    const userRole = req.user.role;
    const hasAccess = (recherche.dossier.createdById === userId ||
        recherche.dossier.assignedToId === userId ||
        ['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(userRole));
    if (!hasAccess) {
        throw new errorHandler_1.ValidationError('Accès refusé à cette recherche');
    }
    res.json({
        success: true,
        data: { recherche }
    });
}));
exports.default = router;
//# sourceMappingURL=recherches.js.map