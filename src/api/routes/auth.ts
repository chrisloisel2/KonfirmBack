import { Router, Request, Response } from 'express';
import prisma from '../../lib/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
	AppError,
	AuthenticationError,
	ValidationError,
	asyncHandler
} from '../../middleware/errorHandler';
import { authenticateToken } from '../../middleware/auth';
import {
	logAuthEvent,
	logSecurityEvent,
	logSystemEvent
} from '../../utils/logger';

const router = Router();
const DEV_ADMIN_EMAIL = (process.env.ADMIN_DEV_EMAIL || 'admin@konfirm.local').toLowerCase();
const DEV_ADMIN_PASSWORD = process.env.ADMIN_DEV_PASSWORD || 'Konfirm2024!';

// Validation schemas
const loginSchema = z.object({
	email: z.string().email('Email invalide'),
	password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères')
});

const signupSchema = z.object({
	email: z.string().email('Email invalide'),
	password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
	confirmPassword: z.string().min(8, 'Confirmation du mot de passe requise'),
	firstName: z.string().min(2, 'Prénom requis'),
	lastName: z.string().min(2, 'Nom requis'),
	companyName: z.string().min(2, 'Nom de société requis'),
	activationKey: z.string().min(8, 'Clé d\'activation requise')
}).refine((data) => data.password === data.confirmPassword, {
	message: "Les mots de passe ne correspondent pas",
	path: ["confirmPassword"],
});

const changePasswordSchema = z.object({
	currentPassword: z.string().min(1, 'Mot de passe actuel requis'),
	newPassword: z.string().min(8, 'Le nouveau mot de passe doit contenir au moins 8 caractères'),
	confirmPassword: z.string().min(1, 'Confirmation du mot de passe requise')
}).refine((data) => data.newPassword === data.confirmPassword, {
	message: "Les mots de passe ne correspondent pas",
	path: ["confirmPassword"],
});

// Génération de token JWT
function generateToken(userId: string, role: string): string {
	const payload = {
		userId,
		role,
		iat: Math.floor(Date.now() / 1000)
	};

	return jwt.sign(payload, process.env.JWT_SECRET!, {
		expiresIn: (process.env.JWT_EXPIRES_IN || '24h') as any,
		issuer: 'konfirm-api',
		audience: 'konfirm-app'
	});
}

function generateSessionId(userId: string): string {
	return jwt.sign(
		{ userId, timestamp: Date.now() },
		process.env.SESSION_SECRET!
	);
}

function buildSubscriptionEndDate(billingCycle: string): Date {
	const end = new Date();
	if (billingCycle === 'YEARLY') {
		end.setFullYear(end.getFullYear() + 1);
	} else {
		end.setMonth(end.getMonth() + 1);
	}
	return end;
}

function buildPaymentReference(): string {
	return `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function validatePassword(user: { id: string; email: string; passwordHash: string }, password: string): Promise<boolean> {
	const matchesHash = await bcrypt.compare(password, user.passwordHash);
	if (matchesHash) return true;

	const isDevAdminLogin =
		process.env.NODE_ENV !== 'production' &&
		user.email.toLowerCase() === DEV_ADMIN_EMAIL &&
		password === DEV_ADMIN_PASSWORD;

	if (!isDevAdminLogin) return false;

	const repairedHash = await bcrypt.hash(DEV_ADMIN_PASSWORD, 12);
	await prisma.user.update({
		where: { id: user.id },
		data: {
			passwordHash: repairedHash,
			loginAttempts: 0,
			lockedUntil: null,
			isBlocked: false,
			isActive: true,
		}
	});

	logSystemEvent({
		action: 'dev_admin_password_repaired',
		component: 'auth_login',
		details: { email: user.email },
		severity: 'warning'
	});

	return true;
}

// Vérification des tentatives de connexion
async function checkSubscriptionAccess(userId: string, companyId: string | null | undefined): Promise<void> {
	let subscription: { status: string } | null = null;

	if (companyId) {
		subscription = await prisma.subscription.findUnique({
			where: { companyId },
			select: { status: true },
		});
	} else {
		subscription = await (prisma as any).subscription.findFirst({
			where: { userId },
			select: { status: true },
		});
	}

	if (!subscription) return; // Pas d'abonnement trouvé → dev/admin, on laisse passer

	if (subscription.status === 'EXPIRED') {
		throw new AuthenticationError('Votre abonnement a expiré. Contactez votre responsable.');
	}
	if (subscription.status === 'SUSPENDED') {
		throw new AuthenticationError('Votre abonnement est suspendu. Contactez votre responsable.');
	}
}


// POST /api/auth/signup
router.post('/signup', asyncHandler(async (req: Request, res: Response) => {
	const {
		email,
		password,
		firstName,
		lastName,
		companyName,
		activationKey,
	} = signupSchema.parse(req.body);

	const normalizedEmail = email.toLowerCase();
	const normalizedActivationKey = activationKey.trim().toUpperCase();

	const existingUser = await prisma.user.findUnique({
		where: { email: normalizedEmail },
		select: { id: true }
	});

	if (existingUser) {
		throw new ValidationError('Un compte existe déjà avec cet email');
	}

	const keyRecord = await (prisma as any).activationKey.findUnique({
		where: { code: normalizedActivationKey },
		select: {
			id: true,
			code: true,
			status: true,
			isRedeemed: true,
			expiresAt: true,
			plan: true,
			billingCycle: true,
			priceCents: true,
			currency: true,
			seats: true,
		}
	});

	if (!keyRecord) {
		throw new ValidationError('Clé d’activation invalide');
	}

	if (keyRecord.status !== 'ACTIVE' || keyRecord.isRedeemed) {
		throw new ValidationError('Cette clé d’activation a déjà été utilisée ou désactivée');
	}

	if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
		throw new ValidationError('Cette clé d’activation est expirée');
	}

	const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
	const passwordHash = await bcrypt.hash(password, saltRounds);

	const user = await prisma.user.create({
		data: {
			email: normalizedEmail,
			passwordHash,
			firstName,
			lastName,
			role: 'ADMIN',
			isActive: true,
			isBlocked: false,
			loginAttempts: 0,
			lastLogin: new Date(),
			companyName,
		},
		select: {
			id: true,
			email: true,
			firstName: true,
			lastName: true,
			role: true,
			lastLogin: true,
			companyName: true,
		}
	});

	const subscription = await (prisma as any).subscription.create({
		data: {
			userId: user.id,
			activationKeyId: keyRecord.id,
			companyName,
			plan: keyRecord.plan || 'PRO',
			billingCycle: keyRecord.billingCycle || 'MONTHLY',
			status: 'ACTIVE',
			priceCents: keyRecord.priceCents || 9900,
			currency: keyRecord.currency || 'EUR',
			seats: keyRecord.seats || 1,
			currentPeriodStart: new Date(),
			currentPeriodEnd: buildSubscriptionEndDate(keyRecord.billingCycle || 'MONTHLY'),
		}
	});

	await (prisma as any).payment.create({
		data: {
			userId: user.id,
			subscriptionId: subscription.id,
			reference: buildPaymentReference(),
			amountCents: keyRecord.priceCents || 9900,
			currency: keyRecord.currency || 'EUR',
			status: 'PAID',
			method: 'ACTIVATION_KEY',
			paidAt: new Date(),
			description: `Activation ${keyRecord.plan || 'PRO'} via clé ${keyRecord.code}`,
		}
	});

	await (prisma as any).activationKey.update({
		where: { id: keyRecord.id },
		data: {
			isRedeemed: true,
			status: 'REDEEMED',
			redeemedAt: new Date(),
			redeemedByUserId: user.id,
			redeemedByEmail: user.email,
		}
	});

	const sessionId = generateSessionId(user.id);
	await prisma.session.create({
		data: {
			sessionId,
			userId: user.id,
			ipAddress: req.ip,
			userAgent: req.get('User-Agent'),
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
		}
	});

	const token = generateToken(user.id, user.role);

	res.status(201).json({
		success: true,
		message: 'Compte créé et abonnement activé avec succès',
		data: {
			token,
			sessionId,
			user,
			subscription: {
				id: subscription.id,
				plan: subscription.plan,
				billingCycle: subscription.billingCycle,
				status: subscription.status,
				currentPeriodEnd: subscription.currentPeriodEnd,
			}
		}
	});
}));

// POST /api/auth/login
router.post('/login', asyncHandler(async (req: Request, res: Response) => {
	const { email, password } = loginSchema.parse(req.body);

	// Recherche de l'utilisateur
	const user = await prisma.user.findUnique({
		where: { email: email.toLowerCase() },
		select: {
			id: true,
			email: true,
			passwordHash: true,
			firstName: true,
			lastName: true,
			companyName: true,
			role: true,
			isActive: true,
			isBlocked: true,
			loginAttempts: true,
			lockedUntil: true,
			lastLogin: true,
			companyId: true,
		}
	});

	if (!user) {
		logAuthEvent({
			action: 'login_failed',
			email,
			reason: 'user_not_found',
			ipAddress: req.ip,
			userAgent: req.get('User-Agent')
		});

		throw new AuthenticationError('Identifiants invalides');
	}

	// Vérifications de sécurité
	if (!user.isActive || user.isBlocked) {
		logAuthEvent({
			action: 'login_failed',
			email,
			userId: user.id,
			reason: 'account_disabled',
			ipAddress: req.ip,
			userAgent: req.get('User-Agent')
		});

		throw new AuthenticationError('Compte désactivé');
	}

	// Vérification de l'abonnement
	await checkSubscriptionAccess(user.id, user.companyId);

	// Vérification du mot de passe
	const isValidPassword = await validatePassword(user, password);

	if (!isValidPassword) {
		logAuthEvent({
			action: 'login_failed',
			email,
			userId: user.id,
			reason: 'invalid_password',
			ipAddress: req.ip,
			userAgent: req.get('User-Agent')
		});

		throw new AuthenticationError('Identifiants invalides');
	}

	// Réinitialisation des tentatives et mise à jour de la dernière connexion
	await prisma.user.update({
		where: { id: user.id },
		data: {
			loginAttempts: 0,
			lockedUntil: null,
			lastLogin: new Date()
		}
	});

	// Création de la session
	const sessionId = generateSessionId(user.id);

	await prisma.session.create({
		data: {
			sessionId,
			userId: user.id,
			ipAddress: req.ip,
			userAgent: req.get('User-Agent'),
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h
		}
	});

	// Génération du token JWT
	const token = generateToken(user.id, user.role);

	logAuthEvent({
		action: 'login_success',
		email,
		userId: user.id,
		ipAddress: req.ip,
		userAgent: req.get('User-Agent')
	});

	res.json({
		success: true,
		data: {
			token,
			sessionId,
			user: {
				id: user.id,
				email: user.email,
				firstName: user.firstName,
				lastName: user.lastName,
				companyName: user.companyName,
				role: user.role,
				lastLogin: user.lastLogin
			}
		}
	});
}));

const auth = authenticateToken as any;

// POST /api/auth/logout
router.post('/logout', auth, asyncHandler(async (req: Request, res: Response) => {
	const sessionId = req.headers['x-session-id'] as string;
	const userId = (req as any).user?.id;

	if (sessionId) {
		// Invalidation de la session
		await prisma.session.updateMany({
			where: { sessionId, isValid: true },
			data: { isValid: false }
		});
	}

	if (userId) {
		logAuthEvent({
			action: 'logout',
			userId,
			ipAddress: req.ip,
			userAgent: req.get('User-Agent')
		});
	}

	res.json({
		success: true,
		message: 'Déconnexion réussie'
	});
}));

// GET /api/auth/me
router.get('/me', auth, asyncHandler(async (req: Request, res: Response) => {
	const userId = (req as any).user?.id;

	if (!userId) {
		throw new AuthenticationError();
	}

	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: {
			id: true,
			email: true,
			firstName: true,
			lastName: true,
			companyName: true,
			role: true,
			lastLogin: true,
			createdAt: true,
			isActive: true
		}
	});

	if (!user) {
		throw new AuthenticationError();
	}

	res.json({
		success: true,
		data: { user }
	});
}));

// POST /api/auth/change-password
router.post('/change-password', auth, asyncHandler(async (req: Request, res: Response) => {
	const userId = (req as any).user?.id;

	if (!userId) {
		throw new AuthenticationError();
	}

	const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

	// Récupération de l'utilisateur actuel
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: { id: true, passwordHash: true }
	});

	if (!user) {
		throw new AuthenticationError();
	}

	// Vérification du mot de passe actuel
	const isValidCurrentPassword = await bcrypt.compare(currentPassword, user.passwordHash);

	if (!isValidCurrentPassword) {
		logSecurityEvent({
			userId,
			action: 'password_change_failed',
			details: { reason: 'invalid_current_password' },
			ipAddress: req.ip,
			severity: 'warning'
		});

		throw new ValidationError('Mot de passe actuel incorrect');
	}

	// Hashage du nouveau mot de passe
	const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
	const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

	// Mise à jour du mot de passe
	await prisma.user.update({
		where: { id: userId },
		data: { passwordHash: newPasswordHash }
	});

	// Invalidation de toutes les sessions existantes
	await prisma.session.updateMany({
		where: { userId, isValid: true },
		data: { isValid: false }
	});

	logSecurityEvent({
		userId,
		action: 'password_changed',
		details: { forced_logout: true },
		ipAddress: req.ip,
		severity: 'info'
	});

	res.json({
		success: true,
		message: 'Mot de passe changé avec succès. Veuillez vous reconnecter.'
	});
}));

// GET /api/auth/sessions
router.get('/sessions', auth, asyncHandler(async (req: Request, res: Response) => {
	const userId = (req as any).user?.id;

	if (!userId) {
		throw new AuthenticationError();
	}

	const sessions = await prisma.session.findMany({
		where: {
			userId,
			isValid: true,
			expiresAt: { gt: new Date() }
		},
		select: {
			id: true,
			sessionId: true,
			ipAddress: true,
			userAgent: true,
			createdAt: true,
			expiresAt: true
		},
		orderBy: { createdAt: 'desc' }
	});

	res.json({
		success: true,
		data: { sessions }
	});
}));

// DELETE /api/auth/sessions/:sessionId
router.delete('/sessions/:sessionId', auth, asyncHandler(async (req: Request, res: Response) => {
	const userId = (req as any).user?.id;
	const { sessionId } = req.params;

	if (!userId) {
		throw new AuthenticationError();
	}

	await prisma.session.updateMany({
		where: {
			sessionId,
			userId,
			isValid: true
		},
		data: { isValid: false }
	});

	logSecurityEvent({
		userId,
		action: 'session_terminated',
		details: { sessionId },
		ipAddress: req.ip,
		severity: 'info'
	});

	res.json({
		success: true,
		message: 'Session terminée'
	});
}));

export default router;
