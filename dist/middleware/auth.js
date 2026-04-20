"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireDataValidation = exports.requireDossierAccess = exports.requireSelfOrRole = exports.requireMinimumRole = exports.requireRole = exports.authenticateToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = __importDefault(require("../lib/prisma"));
const errorHandler_1 = require("./errorHandler");
const logger_1 = require("../utils/logger");
// Middleware d'authentification principal
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.startsWith('Bearer ')
            ? authHeader.slice(7)
            : null;
        if (!token) {
            (0, logger_1.logSecurityEvent)({
                action: 'access_denied',
                details: { reason: 'missing_token', url: req.originalUrl },
                ipAddress: req.ip,
                severity: 'warning'
            });
            throw new errorHandler_1.AuthenticationError('Token d\'accès requis');
        }
        // Vérification du token JWT
        const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        // Récupération des informations utilisateur
        const user = await prisma_1.default.user.findUnique({
            where: { id: payload.userId },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                role: true,
                isActive: true,
                isBlocked: true
            }
        });
        if (!user) {
            (0, logger_1.logSecurityEvent)({
                userId: payload.userId,
                action: 'access_denied',
                details: { reason: 'user_not_found', url: req.originalUrl },
                ipAddress: req.ip,
                severity: 'warning'
            });
            throw new errorHandler_1.AuthenticationError('Utilisateur non trouvé');
        }
        if (!user.isActive || user.isBlocked) {
            (0, logger_1.logSecurityEvent)({
                userId: user.id,
                action: 'access_denied',
                details: {
                    reason: 'account_disabled',
                    url: req.originalUrl,
                    isActive: user.isActive,
                    isBlocked: user.isBlocked
                },
                ipAddress: req.ip,
                severity: 'warning'
            });
            throw new errorHandler_1.AuthenticationError('Compte désactivé');
        }
        // Vérification optionnelle de la session
        const sessionId = req.headers['x-session-id'];
        if (sessionId) {
            const session = await prisma_1.default.session.findUnique({
                where: { sessionId },
                select: {
                    isValid: true,
                    expiresAt: true,
                    userId: true
                }
            });
            if (!session || !session.isValid || session.expiresAt < new Date() || session.userId !== user.id) {
                (0, logger_1.logSecurityEvent)({
                    userId: user.id,
                    action: 'access_denied',
                    details: { reason: 'invalid_session', sessionId, url: req.originalUrl },
                    ipAddress: req.ip,
                    severity: 'warning'
                });
                throw new errorHandler_1.AuthenticationError('Session invalide ou expirée');
            }
        }
        // Ajout des informations utilisateur à la requête
        req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            firstName: user.firstName,
            lastName: user.lastName
        };
        next();
    }
    catch (error) {
        if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
            (0, logger_1.logSecurityEvent)({
                action: 'access_denied',
                details: { reason: 'expired_token', url: req.originalUrl },
                ipAddress: req.ip,
                severity: 'info'
            });
            next(new errorHandler_1.AuthenticationError('Token expiré'));
        }
        else if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            (0, logger_1.logSecurityEvent)({
                action: 'access_denied',
                details: { reason: 'invalid_token', error: error.message, url: req.originalUrl },
                ipAddress: req.ip,
                severity: 'warning'
            });
            next(new errorHandler_1.AuthenticationError('Token invalide'));
        }
        else {
            next(error);
        }
    }
};
exports.authenticateToken = authenticateToken;
// Middleware d'autorisation basé sur les rôles
const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            next(new errorHandler_1.AuthenticationError());
            return;
        }
        if (!roles.includes(req.user.role)) {
            (0, logger_1.logSecurityEvent)({
                userId: req.user.id,
                action: 'authorization_denied',
                details: {
                    requiredRoles: roles,
                    userRole: req.user.role,
                    url: req.originalUrl
                },
                ipAddress: req.ip,
                severity: 'warning'
            });
            next(new errorHandler_1.AuthorizationError(`Accès refusé. Rôles requis: ${roles.join(', ')}`));
            return;
        }
        next();
    };
};
exports.requireRole = requireRole;
// Vérifications spécifiques pour les opérations sensibles
const requireMinimumRole = (minimumRole) => {
    const roleHierarchy = {
        'CONSEILLER': 1,
        'CAISSE': 2,
        'REFERENT': 3,
        'RESPONSABLE': 4,
        'ADMIN': 5
    };
    return (req, res, next) => {
        if (!req.user) {
            next(new errorHandler_1.AuthenticationError());
            return;
        }
        const userRoleLevel = roleHierarchy[req.user.role] || 0;
        const requiredLevel = roleHierarchy[minimumRole] || 0;
        if (userRoleLevel < requiredLevel) {
            (0, logger_1.logSecurityEvent)({
                userId: req.user.id,
                action: 'authorization_denied',
                details: {
                    minimumRole,
                    userRole: req.user.role,
                    url: req.originalUrl
                },
                ipAddress: req.ip,
                severity: 'warning'
            });
            next(new errorHandler_1.AuthorizationError(`Privilèges insuffisants. Niveau minimum requis: ${minimumRole}`));
            return;
        }
        next();
    };
};
exports.requireMinimumRole = requireMinimumRole;
// Middleware pour les opérations sur ses propres données uniquement
const requireSelfOrRole = (allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            next(new errorHandler_1.AuthenticationError());
            return;
        }
        const targetUserId = req.params.userId || req.body.userId;
        const isOwnData = targetUserId === req.user.id;
        const hasRole = allowedRoles.includes(req.user.role);
        if (!isOwnData && !hasRole) {
            (0, logger_1.logSecurityEvent)({
                userId: req.user.id,
                action: 'authorization_denied',
                details: {
                    reason: 'not_own_data_or_insufficient_role',
                    targetUserId,
                    userRole: req.user.role,
                    allowedRoles,
                    url: req.originalUrl
                },
                ipAddress: req.ip,
                severity: 'warning'
            });
            next(new errorHandler_1.AuthorizationError('Accès refusé à ces données'));
            return;
        }
        next();
    };
};
exports.requireSelfOrRole = requireSelfOrRole;
// Middleware pour vérifier les permissions sur un dossier
const requireDossierAccess = async (req, res, next) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AuthenticationError();
        }
        const dossierId = req.params.dossierId || req.body.dossierId;
        if (!dossierId) {
            throw new errorHandler_1.AuthorizationError('ID de dossier requis');
        }
        const dossier = await prisma_1.default.dossier.findUnique({
            where: { id: dossierId },
            select: {
                id: true,
                createdById: true,
                assignedToId: true,
                validatedById: true
            }
        });
        if (!dossier) {
            throw new errorHandler_1.AuthorizationError('Dossier non trouvé');
        }
        const hasAccess = (
        // Créateur du dossier
        dossier.createdById === req.user.id ||
            // Assigné au dossier
            dossier.assignedToId === req.user.id ||
            // Validateur du dossier
            dossier.validatedById === req.user.id ||
            // Rôles avec accès complet
            ['RESPONSABLE', 'ADMIN'].includes(req.user.role) ||
            // Référent peut voir tous les dossiers
            req.user.role === 'REFERENT');
        if (!hasAccess) {
            (0, logger_1.logSecurityEvent)({
                userId: req.user.id,
                action: 'authorization_denied',
                details: {
                    reason: 'no_dossier_access',
                    dossierId,
                    userRole: req.user.role,
                    url: req.originalUrl
                },
                ipAddress: req.ip,
                severity: 'warning'
            });
            throw new errorHandler_1.AuthorizationError('Accès refusé à ce dossier');
        }
        next();
    }
    catch (error) {
        next(error);
    }
};
exports.requireDossierAccess = requireDossierAccess;
// Middleware de validation pour les données sensibles
const requireDataValidation = (req, res, next) => {
    // Validation des données sensibles (nuites par exemple)
    const sensitiveFields = ['numeroIdentite', 'rib', 'revenus'];
    const requestData = { ...req.body, ...req.query };
    for (const field of sensitiveFields) {
        if (requestData[field] && !req.user) {
            throw new errorHandler_1.AuthenticationError('Authentification requise pour accéder aux données sensibles');
        }
    }
    next();
};
exports.requireDataValidation = requireDataValidation;
//# sourceMappingURL=auth.js.map