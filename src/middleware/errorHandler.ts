import { Request, Response, NextFunction } from 'express';
import logger, { logSystemEvent } from '../utils/logger';

export interface CustomError extends Error {
	statusCode?: number;
	isOperational?: boolean;
	code?: string;
	details?: any;
}

class AppError extends Error {
	public statusCode: number;
	public isOperational: boolean;
	public code: string;
	public details?: any;

	constructor(message: string, statusCode: number, code?: string, details?: any) {
		super(message);
		this.statusCode = statusCode;
		this.isOperational = true;
		this.code = code || 'APP_ERROR';
		this.details = details;

		Error.captureStackTrace(this, this.constructor);
	}
}

// Types d'erreurs spécifiques à la conformité LCB-FT
export class ValidationError extends AppError {
	constructor(message: string, details?: any) {
		super(message, 400, 'VALIDATION_ERROR', details);
	}
}

export class AuthenticationError extends AppError {
	constructor(message: string = 'Authentication failed', details?: any) {
		super(message, 401, 'AUTH_ERROR', details);
	}
}

export class AuthorizationError extends AppError {
	constructor(message: string = 'Insufficient permissions', details?: any) {
		super(message, 403, 'AUTHZ_ERROR', details);
	}
}

export class ComplianceError extends AppError {
	constructor(message: string, details?: any) {
		super(message, 422, 'COMPLIANCE_ERROR', details);
	}
}

export class ExternalServiceError extends AppError {
	constructor(service: string, message: string, details?: any) {
		super(`External service error: ${service} - ${message}`, 502, 'EXTERNAL_SERVICE_ERROR', details);
	}
}

// Gestionnaire d'erreurs principal
const errorHandler = (
	error: CustomError,
	req: Request,
	res: Response,
	next: NextFunction
): void => {
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
			userId: (req as any).user?.id,
			timestamp: new Date().toISOString()
		}
	};

	// Classification des erreurs pour les logs
	if (statusCode >= 500) {
		logger.error('Server Error', errorInfo);
		logSystemEvent({
			action: 'security_alert',
			component: 'error_handler',
			details: errorInfo,
			severity: 'error'
		});
	} else if (statusCode >= 400) {
		logger.warn('Client Error', errorInfo);
	} else {
		logger.info('Application Error', errorInfo);
	}

	// Formatage spécifique pour les erreurs de conformité
	if (code === 'COMPLIANCE_ERROR') {
		logComplianceError(errorInfo);
	}

	// Réponse sécurisée (ne pas exposer les détails en production)
	const isDevelopment = process.env.NODE_ENV === 'development';

	const errorResponse: any = {
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

// Messages d'erreur publics (sans révéler d'information sensible)
function getPublicErrorMessage(statusCode: number): string {
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
function logComplianceError(errorInfo: any) {
	logger.warn('COMPLIANCE_VIOLATION', {
		category: 'compliance',
		action: 'error',
		details: errorInfo,
		requiresReview: true
	});
}

// Gestionnaire d'erreurs asynchrones
export const asyncHandler = (fn: Function) => {
	return (req: Request, res: Response, next: NextFunction) => {
		Promise.resolve(fn(req, res, next)).catch(next);
	};
};

// Middleware pour capturer les erreurs inattendues
export const unhandledErrorHandler = () => {
	// Erreurs non capturées
	process.on('uncaughtException', (error: Error) => {
		logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
		logSystemEvent({
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
	process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
		logger.error('Unhandled Rejection', { reason, promise });
		logSystemEvent({
			action: 'security_alert',
			component: 'unhandled_rejection',
			details: { reason: String(reason) },
			severity: 'critical'
		});
	});
};

export { AppError, errorHandler };
export default errorHandler;
