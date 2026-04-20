import winston from 'winston';
import path from 'path';

// Configuration du logger pour la conformité LCB-FT
const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info',
	format: winston.format.combine(
		winston.format.timestamp({
			format: 'YYYY-MM-DD HH:mm:ss.SSS'
		}),
		winston.format.errors({ stack: true }),
		winston.format.json(),
		winston.format.printf(({ timestamp, level, message, ...meta }) => {
			return JSON.stringify({
				timestamp,
				level: level.toUpperCase(),
				message,
				...meta,
				// Conformité : horodatage immutable pour audit
				auditTimestamp: new Date().toISOString(),
			});
		})
	),
	defaultMeta: {
		service: 'konfirm-backend',
		environment: process.env.NODE_ENV || 'development',
	},
	transports: [
		// Console pour développement
		new winston.transports.Console({
			format: winston.format.combine(
				winston.format.colorize(),
				winston.format.simple()
			)
		}),

		// Fichiers pour production et audit
		new winston.transports.File({
			filename: path.join(process.cwd(), 'logs', 'error.log'),
			level: 'error',
			maxsize: 5242880, // 5MB
			maxFiles: 10,
			tailable: true
		}),

		new winston.transports.File({
			filename: path.join(process.cwd(), 'logs', 'combined.log'),
			maxsize: 5242880, // 5MB
			maxFiles: 20,
			tailable: true
		}),

		// Log spécial pour les événements de conformité
		new winston.transports.File({
			filename: path.join(process.cwd(), 'logs', 'audit.log'),
			level: 'info',
			maxsize: 10485760, // 10MB
			maxFiles: 50, // Archivage 5 ans
			tailable: true,
			format: winston.format.combine(
				winston.format.timestamp(),
				winston.format.json(),
				winston.format.printf(({ timestamp, level, message, ...meta }) => {
					// Format spécial pour l'audit de conformité
					const auditEntry = {
						timestamp,
						level,
						message,
						...meta,
						retention: '5_years', // Marqueur pour la rétention réglementaire
						integrity_hash: generateLogHash(String(timestamp), message as string, meta), // Hash pour l'intégrité
					};
					return JSON.stringify(auditEntry);
				})
			)
		})
	],

	// Gestion des exceptions non capturées
	exceptionHandlers: [
		new winston.transports.File({
			filename: path.join(process.cwd(), 'logs', 'exceptions.log')
		})
	],

	// Gestion des rejections de promesses
	rejectionHandlers: [
		new winston.transports.File({
			filename: path.join(process.cwd(), 'logs', 'rejections.log')
		})
	]
});

// Fonction pour générer un hash d'intégrité des logs (conformité)
function generateLogHash(timestamp: string, message: string, meta: any): string {
	const crypto = require('crypto');
	const content = `${timestamp}${message}${JSON.stringify(meta)}`;
	return crypto.createHash('sha256').update(content).digest('hex');
}

// Méthodes spécifiques pour les événements de conformité
/**
 * Log événement d'authentification (succès/échec)
 */
export function logAuthEvent(event: {
	action: 'login' | 'logout' | 'failed_login' | 'account_locked' | 'login_failed' | 'login_success';
	userId?: string;
	email?: string;
	ip?: string;
	ipAddress?: string;
	userAgent?: string;
	success?: boolean;
	reason?: string;
}) {
	logger.info('AUTH_EVENT', {
		category: 'authentication',
		...event
	});
}

/**
 * Log événement dossier LCB-FT
 */
export function logDossierEvent(event: {
	action: 'create' | 'update' | 'validate' | 'escalate' | 'block' | 'archive'
		| 'client_created' | 'client_updated' | 'dossier_created' | 'dossier_updated' | 'dossier_assigned'
		| 'document_uploaded' | 'document_verified' | 'document_unverified' | 'document_ocr_reprocessed'
		| 'suspicion_evaluated' | 'tracfin_declaration_generated'
		| 'tracfin_declaration_transmitted' | 'tracfin_history_accessed';
	dossierId: string;
	userId: string;
	clientType?: string;
	amount?: number;
	status?: string;
	details?: any;
}) {
	logger.info('DOSSIER_EVENT', {
		category: 'compliance',
		...event
	});
}

/**
 * Log recherche PPE/sanctions/gels
 */
export function logResearchEvent(event: {
	action: 'search' | 'result' | 'cache_hit'
		| 'ppe_match_detected' | 'ppe_search_completed'
		| 'sanctions_match_detected' | 'sanctions_search_completed'
		| 'asset_freeze_match_detected' | 'asset_freeze_search_completed'
		| 'complete_search_finished';
	searchType?: string;
	rechercheId?: string;
	dossierId?: string;
	userId?: string;
	query?: string;
	source?: string;
	results?: number;
	hasAlerts?: boolean;
	details?: any;
}) {
	logger.info('RESEARCH_EVENT', {
		category: 'research',
		...event
	});
}

/**
 * Log événement scoring et décision automatique
 */
export function logScoringEvent(event: {
	action: 'calculate' | 'decision' | 'override' | 'scoring_calculated';
	dossierId?: string;
	userId?: string;
	scores?: any;
	finalScore?: number;
	decision?: string;
	isAutomatic?: boolean;
	justification?: string;
	details?: any;
}) {
	logger.info('SCORING_EVENT', {
		category: 'scoring',
		...event
	});
}

/**
 * Log exception et validation humaine
 */
export function logExceptionEvent(event: {
	action: 'create' | 'validate' | 'escalate' | 'resolve' | 'exception_created' | 'exception_updated' | 'exception_assigned';
	exceptionType?: string;
	exceptionId?: string;
	dossierId?: string;
	userId?: string;
	validatorRole?: string;
	decision?: string;
	justification?: string;
	details?: any;
}) {
	logger.info('EXCEPTION_EVENT', {
		category: 'exception',
		...event
	});
}

/**
 * Log événements système critiques
 */
export function logSystemEvent(event: {
	action: 'startup' | 'shutdown' | 'backup' | 'migration' | 'security_alert'
		| 'ocr_start' | 'ocr_done' | 'ocr_failed'
		| 'ocr_progress' | 'ocr_error' | 'file_cleanup_error' | 'document_upload_error'
		| 'external_api_request' | 'external_api_response' | 'external_api_error'
		| 'lcb_ft_verification_start' | 'lcb_ft_verification_complete'
		| 'tracfin_declaration_generated' | 'ermes_transmission_start'
		| 'ermes_transmission_success' | 'ermes_transmission_error'
		| 'declaration_history_request'
		// Search system
		| 'search_history_error'
		| 'osint_mega_start' | 'osint_mega_complete'
		| 'intelligence_report_start' | 'intelligence_report_complete' | 'intelligence_report_save_error'
		| 'watchlist_check_error' | 'watchlist_batch_check_start' | 'watchlist_batch_check_error' | 'watchlist_batch_check_complete'
		| 'batch_search_start' | 'batch_search_complete'
		| string; // extensible fallback
	component?: string;
	details?: any;
	severity: 'info' | 'warning' | 'warn' | 'error' | 'critical';
}) {
	const logLevel = event.severity === 'critical' || event.severity === 'error' ? 'error' :
		event.severity === 'warning' ? 'warn' : 'info';

	logger[logLevel]('SYSTEM_EVENT', {
		category: 'system',
		...event
	});
}

export function logSecurityEvent(event: {
	userId?: string;
	action: string;
	details?: any;
	ipAddress?: string;
	severity: 'info' | 'warning' | 'error' | 'critical';
}) {
	const logLevel = event.severity === 'critical' || event.severity === 'error' ? 'error' :
		event.severity === 'warning' ? 'warn' : 'info';
	logger[logLevel]('SECURITY_EVENT', {
		category: 'security',
		...event
	});
}

export function logAuditEvent(event: {
	userId?: string;
	action: string;
	resource?: string;
	resourceId?: string;
	oldValues?: any;
	newValues?: any;
	ipAddress?: string;
	metadata?: any;
	details?: any;
}) {
	logger.info('AUDIT_EVENT', {
		category: 'audit',
		...event
	});
}

export const logRechercheEvent = logResearchEvent;

export default logger;
