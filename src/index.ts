import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import passport from 'passport';
import dotenv from 'dotenv';
import logger, { logSystemEvent } from './utils/logger';
import errorHandler, { unhandledErrorHandler } from './middleware/errorHandler';
import apiRoutes from './api';

// Charger les variables d'environnement
dotenv.config();

// Initialisation du gestionnaire d'erreurs async
unhandledErrorHandler();

const app = express();
const PORT = process.env.PORT || 3001;

// Faire confiance au premier proxy (nginx) pour X-Forwarded-For
app.set('trust proxy', 1);

// Sécurité avec Helmet
app.use(helmet({
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
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Compression
app.use(compression());

// Rate limiting global
const globalRateLimit = rateLimit({
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Initialisation de Passport (pour OAuth, etc.)
app.use(passport.initialize());

// Logging des requêtes
app.use((req, res, next) => {
	const start = Date.now();

	res.on('finish', () => {
		const duration = Date.now() - start;
		logger.info('HTTP Request', {
			method: req.method,
			url: req.originalUrl,
			statusCode: res.statusCode,
			duration: `${duration}ms`,
			ip: req.ip,
			userAgent: req.get('User-Agent'),
			userId: (req as any).user?.id || 'anonymous'
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
app.use('/api', apiRoutes);

// Middleware de gestion d'erreurs (doit être après toutes les routes)
app.use(errorHandler);

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
	logSystemEvent({
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

	logger.info(`🚀 Serveur Konfirm LCB-FT démarré sur le port ${PORT}`);
	logger.info(`🌍 Environnement: ${process.env.NODE_ENV || 'development'}`);
	logger.info(`📋 Health check: http://localhost:${PORT}/api/health`);
	logger.info(`🔒 Authentication: http://localhost:${PORT}/api/auth`);
	logger.info(`📊 Endpoints disponibles:`);
	logger.info(`   - Dossiers: /api/dossiers`);
	logger.info(`   - Documents: /api/documents`);
	logger.info(`   - Recherches: /api/recherches`);
	logger.info(`   - Scoring: /api/scoring`);
	logger.info(`   - Exceptions: /api/exceptions`);
});

// Gestion propre de l'arrêt du serveur
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown(signal: string) {
	logger.info(`Réception du signal ${signal}. Arrêt du serveur...`);

	logSystemEvent({
		action: 'shutdown',
		component: 'express_server',
		details: { signal },
		severity: 'info'
	});

	server.close(() => {
		logger.info('Serveur arrêté proprement');
		process.exit(0);
	});

	// Force l'arrêt après 10 secondes
	setTimeout(() => {
		logger.error('Arrêt forcé du serveur après timeout');
		process.exit(1);
	}, 10000);
}
