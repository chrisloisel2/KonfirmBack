"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logRechercheEvent = void 0;
exports.logAuthEvent = logAuthEvent;
exports.logDossierEvent = logDossierEvent;
exports.logResearchEvent = logResearchEvent;
exports.logScoringEvent = logScoringEvent;
exports.logExceptionEvent = logExceptionEvent;
exports.logSystemEvent = logSystemEvent;
exports.logSecurityEvent = logSecurityEvent;
exports.logAuditEvent = logAuditEvent;
const winston_1 = __importDefault(require("winston"));
const path_1 = __importDefault(require("path"));
// Configuration du logger pour la conformité LCB-FT
const logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss.SSS'
    }), winston_1.default.format.errors({ stack: true }), winston_1.default.format.json(), winston_1.default.format.printf(({ timestamp, level, message, ...meta }) => {
        return JSON.stringify({
            timestamp,
            level: level.toUpperCase(),
            message,
            ...meta,
            // Conformité : horodatage immutable pour audit
            auditTimestamp: new Date().toISOString(),
        });
    })),
    defaultMeta: {
        service: 'konfirm-backend',
        environment: process.env.NODE_ENV || 'development',
    },
    transports: [
        // Console pour développement
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple())
        }),
        // Fichiers pour production et audit
        new winston_1.default.transports.File({
            filename: path_1.default.join(process.cwd(), 'logs', 'error.log'),
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 10,
            tailable: true
        }),
        new winston_1.default.transports.File({
            filename: path_1.default.join(process.cwd(), 'logs', 'combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 20,
            tailable: true
        }),
        // Log spécial pour les événements de conformité
        new winston_1.default.transports.File({
            filename: path_1.default.join(process.cwd(), 'logs', 'audit.log'),
            level: 'info',
            maxsize: 10485760, // 10MB
            maxFiles: 50, // Archivage 5 ans
            tailable: true,
            format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json(), winston_1.default.format.printf(({ timestamp, level, message, ...meta }) => {
                // Format spécial pour l'audit de conformité
                const auditEntry = {
                    timestamp,
                    level,
                    message,
                    ...meta,
                    retention: '5_years', // Marqueur pour la rétention réglementaire
                    integrity_hash: generateLogHash(String(timestamp), message, meta), // Hash pour l'intégrité
                };
                return JSON.stringify(auditEntry);
            }))
        })
    ],
    // Gestion des exceptions non capturées
    exceptionHandlers: [
        new winston_1.default.transports.File({
            filename: path_1.default.join(process.cwd(), 'logs', 'exceptions.log')
        })
    ],
    // Gestion des rejections de promesses
    rejectionHandlers: [
        new winston_1.default.transports.File({
            filename: path_1.default.join(process.cwd(), 'logs', 'rejections.log')
        })
    ]
});
// Fonction pour générer un hash d'intégrité des logs (conformité)
function generateLogHash(timestamp, message, meta) {
    const crypto = require('crypto');
    const content = `${timestamp}${message}${JSON.stringify(meta)}`;
    return crypto.createHash('sha256').update(content).digest('hex');
}
// Méthodes spécifiques pour les événements de conformité
/**
 * Log événement d'authentification (succès/échec)
 */
function logAuthEvent(event) {
    logger.info('AUTH_EVENT', {
        category: 'authentication',
        ...event
    });
}
/**
 * Log événement dossier LCB-FT
 */
function logDossierEvent(event) {
    logger.info('DOSSIER_EVENT', {
        category: 'compliance',
        ...event
    });
}
/**
 * Log recherche PPE/sanctions/gels
 */
function logResearchEvent(event) {
    logger.info('RESEARCH_EVENT', {
        category: 'research',
        ...event
    });
}
/**
 * Log événement scoring et décision automatique
 */
function logScoringEvent(event) {
    logger.info('SCORING_EVENT', {
        category: 'scoring',
        ...event
    });
}
/**
 * Log exception et validation humaine
 */
function logExceptionEvent(event) {
    logger.info('EXCEPTION_EVENT', {
        category: 'exception',
        ...event
    });
}
/**
 * Log événements système critiques
 */
function logSystemEvent(event) {
    const logLevel = event.severity === 'critical' || event.severity === 'error' ? 'error' :
        event.severity === 'warning' ? 'warn' : 'info';
    logger[logLevel]('SYSTEM_EVENT', {
        category: 'system',
        ...event
    });
}
function logSecurityEvent(event) {
    const logLevel = event.severity === 'critical' || event.severity === 'error' ? 'error' :
        event.severity === 'warning' ? 'warn' : 'info';
    logger[logLevel]('SECURITY_EVENT', {
        category: 'security',
        ...event
    });
}
function logAuditEvent(event) {
    logger.info('AUDIT_EVENT', {
        category: 'audit',
        ...event
    });
}
exports.logRechercheEvent = logResearchEvent;
exports.default = logger;
//# sourceMappingURL=logger.js.map