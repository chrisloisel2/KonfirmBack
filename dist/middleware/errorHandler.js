"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = exports.AppError = exports.unhandledErrorHandler = exports.asyncHandler = exports.ExternalServiceError = exports.ComplianceError = exports.AuthorizationError = exports.AuthenticationError = exports.ValidationError = void 0;
const logger_1 = __importStar(require("../utils/logger"));
class AppError extends Error {
    statusCode;
    isOperational;
    code;
    details;
    constructor(message, statusCode, code, details) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        this.code = code || 'APP_ERROR';
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
// Types d'erreurs spécifiques à la conformité LCB-FT
class ValidationError extends AppError {
    constructor(message, details) {
        super(message, 400, 'VALIDATION_ERROR', details);
    }
}
exports.ValidationError = ValidationError;
class AuthenticationError extends AppError {
    constructor(message = 'Authentication failed', details) {
        super(message, 401, 'AUTH_ERROR', details);
    }
}
exports.AuthenticationError = AuthenticationError;
class AuthorizationError extends AppError {
    constructor(message = 'Insufficient permissions', details) {
        super(message, 403, 'AUTHZ_ERROR', details);
    }
}
exports.AuthorizationError = AuthorizationError;
class ComplianceError extends AppError {
    constructor(message, details) {
        super(message, 422, 'COMPLIANCE_ERROR', details);
    }
}
exports.ComplianceError = ComplianceError;
class ExternalServiceError extends AppError {
    constructor(service, message, details) {
        super(`External service error: ${service} - ${message}`, 502, 'EXTERNAL_SERVICE_ERROR', details);
    }
}
exports.ExternalServiceError = ExternalServiceError;
// Gestionnaire d'erreurs principal
const errorHandler = (error, req, res, next) => {
    let { statusCode = 500, message, code, details } = error;
    // Log de l'erreur pour audit et conformité
    const errorInfo = {
        error: {
            message,
            code,
            statusCode,
            stack: error.stack,
            details
        },
        request: {
            method: req.method,
            url: req.originalUrl,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            userId: req.user?.id,
            timestamp: new Date().toISOString()
        }
    };
    // Classification des erreurs pour les logs
    if (statusCode >= 500) {
        logger_1.default.error('Server Error', errorInfo);
        (0, logger_1.logSystemEvent)({
            action: 'security_alert',
            component: 'error_handler',
            details: errorInfo,
            severity: 'error'
        });
    }
    else if (statusCode >= 400) {
        logger_1.default.warn('Client Error', errorInfo);
    }
    else {
        logger_1.default.info('Application Error', errorInfo);
    }
    // Formatage spécifique pour les erreurs de conformité
    if (code === 'COMPLIANCE_ERROR') {
        logComplianceError(errorInfo);
    }
    // Réponse sécurisée (ne pas exposer les détails en production)
    const isDevelopment = process.env.NODE_ENV === 'development';
    const errorResponse = {
        success: false,
        error: {
            message: isDevelopment ? message : getPublicErrorMessage(statusCode),
            code,
            timestamp: new Date().toISOString()
        }
    };
    // Ajouter les détails en développement uniquement
    if (isDevelopment && details) {
        errorResponse.error.details = details;
    }
    // Ajouter des headers de sécurité
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block'
    });
    res.status(statusCode).json(errorResponse);
};
exports.errorHandler = errorHandler;
// Messages d'erreur publics (sans révéler d'information sensible)
function getPublicErrorMessage(statusCode) {
    switch (statusCode) {
        case 400:
            return 'Données invalides';
        case 401:
            return 'Authentification requise';
        case 403:
            return 'Accès refusé';
        case 404:
            return 'Ressource non trouvée';
        case 422:
            return 'Données non conformes aux règles métier';
        case 429:
            return 'Trop de requêtes, veuillez réessayer plus tard';
        case 500:
            return 'Erreur interne du serveur';
        case 502:
            return 'Service externe indisponible';
        case 503:
            return 'Service temporairement indisponible';
        default:
            return 'Une erreur est survenue';
    }
}
// Logging spécialisé pour les erreurs de conformité
function logComplianceError(errorInfo) {
    logger_1.default.warn('COMPLIANCE_VIOLATION', {
        category: 'compliance',
        action: 'error',
        details: errorInfo,
        requiresReview: true
    });
}
// Gestionnaire d'erreurs asynchrones
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};
exports.asyncHandler = asyncHandler;
// Middleware pour capturer les erreurs inattendues
const unhandledErrorHandler = () => {
    // Erreurs non capturées
    process.on('uncaughtException', (error) => {
        logger_1.default.error('Uncaught Exception', { error: error.message, stack: error.stack });
        (0, logger_1.logSystemEvent)({
            action: 'security_alert',
            component: 'uncaught_exception',
            details: { error: error.message },
            severity: 'critical'
        });
        // En production, on redémarre proprement
        if (process.env.NODE_ENV === 'production') {
            process.exit(1);
        }
    });
    // Rejections de promesses non gérées
    process.on('unhandledRejection', (reason, promise) => {
        logger_1.default.error('Unhandled Rejection', { reason, promise });
        (0, logger_1.logSystemEvent)({
            action: 'security_alert',
            component: 'unhandled_rejection',
            details: { reason: String(reason) },
            severity: 'critical'
        });
    });
};
exports.unhandledErrorHandler = unhandledErrorHandler;
exports.default = errorHandler;
//# sourceMappingURL=errorHandler.js.map