import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { AuthenticationError, AuthorizationError } from './errorHandler';
import { logSecurityEvent } from '../utils/logger';


interface JWTPayload {
	userId: string;
	role: string;
	iat: number;
	exp: number;
}

declare global {
	namespace Express {
		interface User {
			id: string;
			email: string;
			role: string;
			firstName: string;
			lastName: string;
		}
	}
}

interface AuthenticatedRequest extends Request {
	user?: Express.User;
}

// Middleware d'authentification principal
export const authenticateToken = async (
	req: AuthenticatedRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		const authHeader = req.headers.authorization;
		const token = authHeader && authHeader.startsWith('Bearer ')
			? authHeader.slice(7)
			: null;

		if (!token) {
			logSecurityEvent({
				action: 'access_denied',
				details: { reason: 'missing_token', url: req.originalUrl },
				ipAddress: req.ip,
				severity: 'warning'
			});
			throw new AuthenticationError('Token d\'accès requis');
		}

		// Vérification du token JWT
		const payload = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;

		// Récupération des informations utilisateur
		const user = await prisma.user.findUnique({
			where: { id: payload.userId },
			select: {
				id: true,
				email: true,
				firstName: true,
				lastName: true,
				role: true,
				isActive: true,
				isBlocked: true,
				companyId: true,
			}
		});

		if (!user) {
			logSecurityEvent({
				userId: payload.userId,
				action: 'access_denied',
				details: { reason: 'user_not_found', url: req.originalUrl },
				ipAddress: req.ip,
				severity: 'warning'
			});
			throw new AuthenticationError('Utilisateur non trouvé');
		}

		if (!user.isActive || user.isBlocked) {
			logSecurityEvent({
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
			throw new AuthenticationError('Compte désactivé');
		}

		// Vérification statut abonnement (uniquement si lié à une société)
		if (user.companyId) {
			const subscription = await prisma.subscription.findUnique({
				where: { companyId: user.companyId },
				select: { status: true },
			});
			if (subscription && (subscription.status === 'EXPIRED' || subscription.status === 'SUSPENDED')) {
				logSecurityEvent({
					userId: user.id,
					action: 'access_denied',
					details: { reason: 'subscription_inactive', status: subscription.status, url: req.originalUrl },
					ipAddress: req.ip,
					severity: 'warning'
				});
				throw new AuthenticationError('Abonnement inactif. Contactez votre responsable.');
			}
		}

		// Vérification optionnelle de la session
		const sessionId = req.headers['x-session-id'] as string;
		if (sessionId) {
			const session = await prisma.session.findUnique({
				where: { sessionId },
				select: {
					isValid: true,
					expiresAt: true,
					userId: true
				}
			});

			if (!session || !session.isValid || session.expiresAt < new Date() || session.userId !== user.id) {
				logSecurityEvent({
					userId: user.id,
					action: 'access_denied',
					details: { reason: 'invalid_session', sessionId, url: req.originalUrl },
					ipAddress: req.ip,
					severity: 'warning'
				});
				throw new AuthenticationError('Session invalide ou expirée');
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
	} catch (error) {
		if (error instanceof jwt.TokenExpiredError) {
			logSecurityEvent({
				action: 'access_denied',
				details: { reason: 'expired_token', url: req.originalUrl },
				ipAddress: req.ip,
				severity: 'info'
			});
			next(new AuthenticationError('Token expiré'));
		} else if (error instanceof jwt.JsonWebTokenError) {
			logSecurityEvent({
				action: 'access_denied',
				details: { reason: 'invalid_token', error: error.message, url: req.originalUrl },
				ipAddress: req.ip,
				severity: 'warning'
			});
			next(new AuthenticationError('Token invalide'));
		} else {
			next(error);
		}
	}
};

// Middleware d'autorisation basé sur les rôles
export const requireRole = (...roles: string[]) => {
	return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
		if (!req.user) {
			next(new AuthenticationError());
			return;
		}

		if (!roles.includes(req.user.role)) {
			logSecurityEvent({
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
			next(new AuthorizationError(`Accès refusé. Rôles requis: ${roles.join(', ')}`));
			return;
		}

		next();
	};
};

// Vérifications spécifiques pour les opérations sensibles
export const requireMinimumRole = (minimumRole: string) => {
	const roleHierarchy = {
		'CONSEILLER': 1,
		'CAISSE': 2,
		'REFERENT': 3,
		'RESPONSABLE': 4,
		'ADMIN': 5
	};

	return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
		if (!req.user) {
			next(new AuthenticationError());
			return;
		}

		const userRoleLevel = roleHierarchy[req.user.role as keyof typeof roleHierarchy] || 0;
		const requiredLevel = roleHierarchy[minimumRole as keyof typeof roleHierarchy] || 0;

		if (userRoleLevel < requiredLevel) {
			logSecurityEvent({
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
			next(new AuthorizationError(`Privilèges insuffisants. Niveau minimum requis: ${minimumRole}`));
			return;
		}

		next();
	};
};

// Middleware pour les opérations sur ses propres données uniquement
export const requireSelfOrRole = (allowedRoles: string[]) => {
	return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
		if (!req.user) {
			next(new AuthenticationError());
			return;
		}

		const targetUserId = req.params.userId || req.body.userId;
		const isOwnData = targetUserId === req.user.id;
		const hasRole = allowedRoles.includes(req.user.role);

		if (!isOwnData && !hasRole) {
			logSecurityEvent({
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
			next(new AuthorizationError('Accès refusé à ces données'));
			return;
		}

		next();
	};
};

// Middleware pour vérifier les permissions sur un dossier
export const requireDossierAccess = async (
	req: AuthenticatedRequest,
	res: Response,
	next: NextFunction
): Promise<void> => {
	try {
		if (!req.user) {
			throw new AuthenticationError();
		}

		const dossierId = req.params.dossierId || req.body.dossierId;

		if (!dossierId) {
			throw new AuthorizationError('ID de dossier requis');
		}

		const dossier = await prisma.dossier.findUnique({
			where: { id: dossierId },
			select: {
				id: true,
				createdById: true,
				assignedToId: true,
				validatedById: true
			}
		});

		if (!dossier) {
			throw new AuthorizationError('Dossier non trouvé');
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
			req.user.role === 'REFERENT'
		);

		if (!hasAccess) {
			logSecurityEvent({
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
			throw new AuthorizationError('Accès refusé à ce dossier');
		}

		next();
	} catch (error) {
		next(error);
	}
};

// Middleware de validation pour les données sensibles
export const requireDataValidation = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
	// Validation des données sensibles (nuites par exemple)
	const sensitiveFields = ['numeroIdentite', 'rib', 'revenus'];
	const requestData = { ...req.body, ...req.query };

	for (const field of sensitiveFields) {
		if (requestData[field] && !req.user) {
			throw new AuthenticationError('Authentification requise pour accéder aux données sensibles');
		}
	}

	next();
};

export { AuthenticatedRequest };
