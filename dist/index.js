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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const passport_1 = __importDefault(require("passport"));
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = __importStar(require("./utils/logger"));
const errorHandler_1 = __importStar(require("./middleware/errorHandler"));
const api_1 = __importDefault(require("./api"));
// Charger les variables d'environnement
dotenv_1.default.config();
// Initialisation du gestionnaire d'erreurs async
(0, errorHandler_1.unhandledErrorHandler)();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
// Sécurité avec Helmet
app.use((0, helmet_1.default)({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));
// CORS
const corsOrigins = process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'];
const isDev = process.env.NODE_ENV !== 'production';
const corsOptions = {
    origin: isDev ? /^http:\/\/localhost(:\d+)?$/ : corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    ...(isDev ? {} : { allowedHeaders: ['Content-Type', 'Authorization', 'x-session-id'] }),
};
app.use((0, cors_1.default)(corsOptions));
app.options('*', (0, cors_1.default)(corsOptions));
// Compression
app.use((0, compression_1.default)());
// Rate limiting global
const globalRateLimit = (0, express_rate_limit_1.default)({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOWS_MS || '900000'), // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
    message: {
        error: 'Trop de requêtes, veuillez réessayer plus tard.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(globalRateLimit);
// Parsing JSON et URL encoded
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
// Initialisation de Passport (pour OAuth, etc.)
app.use(passport_1.default.initialize());
// Logging des requêtes
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger_1.default.info('HTTP Request', {
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            userId: req.user?.id || 'anonymous'
        });
    });
    next();
});
// Route racine
app.get('/', (req, res) => {
    res.json({
        message: 'API Konfirm - Conformité LCB-FT',
        version: '1.0.0',
        status: 'Opérationnel',
        documentation: '/api/health',
        environment: process.env.NODE_ENV || 'development'
    });
});
// Routes API principales
app.use('/api', api_1.default);
// Middleware de gestion d'erreurs (doit être après toutes les routes)
app.use(errorHandler_1.default);
// Gestion des routes non trouvées (doit être en dernier)
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: {
            message: 'Route non trouvée',
            path: req.originalUrl,
            method: req.method,
            timestamp: new Date().toISOString()
        }
    });
});
// Démarrage du serveur
const server = app.listen(PORT, () => {
    (0, logger_1.logSystemEvent)({
        action: 'startup',
        component: 'express_server',
        details: {
            port: PORT,
            environment: process.env.NODE_ENV,
            nodeVersion: process.version,
            platform: process.platform,
            corsOrigins,
            features: {
                authentication: true,
                fileUpload: true,
                ocr: true,
                externalApis: true,
                auditLogging: true,
                compliance: true
            }
        },
        severity: 'info'
    });
    logger_1.default.info(`🚀 Serveur Konfirm LCB-FT démarré sur le port ${PORT}`);
    logger_1.default.info(`🌍 Environnement: ${process.env.NODE_ENV || 'development'}`);
    logger_1.default.info(`📋 Health check: http://localhost:${PORT}/api/health`);
    logger_1.default.info(`🔒 Authentication: http://localhost:${PORT}/api/auth`);
    logger_1.default.info(`📊 Endpoints disponibles:`);
    logger_1.default.info(`   - Dossiers: /api/dossiers`);
    logger_1.default.info(`   - Documents: /api/documents`);
    logger_1.default.info(`   - Recherches: /api/recherches`);
    logger_1.default.info(`   - Scoring: /api/scoring`);
    logger_1.default.info(`   - Exceptions: /api/exceptions`);
});
// Gestion propre de l'arrêt du serveur
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
function gracefulShutdown(signal) {
    logger_1.default.info(`Réception du signal ${signal}. Arrêt du serveur...`);
    (0, logger_1.logSystemEvent)({
        action: 'shutdown',
        component: 'express_server',
        details: { signal },
        severity: 'info'
    });
    server.close(() => {
        logger_1.default.info('Serveur arrêté proprement');
        process.exit(0);
    });
    // Force l'arrêt après 10 secondes
    setTimeout(() => {
        logger_1.default.error('Arrêt forcé du serveur après timeout');
        process.exit(1);
    }, 10000);
}
//# sourceMappingURL=index.js.map