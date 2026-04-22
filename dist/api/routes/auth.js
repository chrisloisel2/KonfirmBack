"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../../lib/prisma"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const logger_1 = require("../../utils/logger");
const router = (0, express_1.Router)();
const DEV_ADMIN_EMAIL = (process.env.ADMIN_DEV_EMAIL || 'admin@konfirm.local').toLowerCase();
const DEV_ADMIN_PASSWORD = process.env.ADMIN_DEV_PASSWORD || 'Konfirm2024!';
// Rate limiting pour l'authentification
const authRateLimit = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 tentatives par IP
    message: {
        error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});
// Validation schemas
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email('Email invalide'),
    password: zod_1.z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères')
});
const signupSchema = zod_1.z.object({
    email: zod_1.z.string().email('Email invalide'),
    password: zod_1.z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
    confirmPassword: zod_1.z.string().min(8, 'Confirmation du mot de passe requise'),
    firstName: zod_1.z.string().min(2, 'Prénom requis'),
    lastName: zod_1.z.string().min(2, 'Nom requis'),
    companyName: zod_1.z.string().min(2, 'Nom de société requis'),
    activationKey: zod_1.z.string().min(8, 'Clé d\'activation requise')
}).refine((data) => data.password === data.confirmPassword, {
    message: "Les mots de passe ne correspondent pas",
    path: ["confirmPassword"],
});
const changePasswordSchema = zod_1.z.object({
    currentPassword: zod_1.z.string().min(1, 'Mot de passe actuel requis'),
    newPassword: zod_1.z.string().min(8, 'Le nouveau mot de passe doit contenir au moins 8 caractères'),
    confirmPassword: zod_1.z.string().min(1, 'Confirmation du mot de passe requise')
}).refine((data) => data.newPassword === data.confirmPassword, {
    message: "Les mots de passe ne correspondent pas",
    path: ["confirmPassword"],
});
// Génération de token JWT
function generateToken(userId, role) {
    const payload = {
        userId,
        role,
        iat: Math.floor(Date.now() / 1000)
    };
    return jsonwebtoken_1.default.sign(payload, process.env.JWT_SECRET, {
        expiresIn: (process.env.JWT_EXPIRES_IN || '24h'),
        issuer: 'konfirm-api',
        audience: 'konfirm-app'
    });
}
function generateSessionId(userId) {
    return jsonwebtoken_1.default.sign({ userId, timestamp: Date.now() }, process.env.SESSION_SECRET);
}
function buildSubscriptionEndDate(billingCycle) {
    const end = new Date();
    if (billingCycle === 'YEARLY') {
        end.setFullYear(end.getFullYear() + 1);
    }
    else {
        end.setMonth(end.getMonth() + 1);
    }
    return end;
}
function buildPaymentReference() {
    return `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}
async function validatePassword(user, password) {
    const matchesHash = await bcryptjs_1.default.compare(password, user.passwordHash);
    if (matchesHash)
        return true;
    const isDevAdminLogin = process.env.NODE_ENV !== 'production' &&
        user.email.toLowerCase() === DEV_ADMIN_EMAIL &&
        password === DEV_ADMIN_PASSWORD;
    if (!isDevAdminLogin)
        return false;
    const repairedHash = await bcryptjs_1.default.hash(DEV_ADMIN_PASSWORD, 12);
    await prisma_1.default.user.update({
        where: { id: user.id },
        data: {
            passwordHash: repairedHash,
            loginAttempts: 0,
            lockedUntil: null,
            isBlocked: false,
            isActive: true,
        }
    });
    (0, logger_1.logSystemEvent)({
        action: 'dev_admin_password_repaired',
        component: 'auth_login',
        details: { email: user.email },
        severity: 'warning'
    });
    return true;
}
// Vérification des tentatives de connexion
async function checkLoginAttempts(user) {
    const maxAttempts = 5;
    const lockoutDuration = 30 * 60 * 1000; // 30 minutes
    if (user.lockedUntil && user.lockedUntil > new Date()) {
        throw new errorHandler_1.AuthenticationError('Compte temporairement verrouillé');
    }
    if (user.loginAttempts >= maxAttempts) {
        const lockoutTime = new Date(Date.now() + lockoutDuration);
        await prisma_1.default.user.update({
            where: { id: user.id },
            data: {
                lockedUntil: lockoutTime,
                loginAttempts: user.loginAttempts + 1
            }
        });
        (0, logger_1.logSecurityEvent)({
            userId: user.id,
            action: 'account_locked',
            details: { attempts: user.loginAttempts + 1 },
            ipAddress: '',
            severity: 'warning'
        });
        throw new errorHandler_1.AuthenticationError('Compte verrouillé pour 30 minutes');
    }
    return true;
}
// POST /api/auth/signup
router.post('/signup', authRateLimit, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { email, password, firstName, lastName, companyName, activationKey, } = signupSchema.parse(req.body);
    const normalizedEmail = email.toLowerCase();
    const normalizedActivationKey = activationKey.trim().toUpperCase();
    const existingUser = await prisma_1.default.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true }
    });
    if (existingUser) {
        throw new errorHandler_1.ValidationError('Un compte existe déjà avec cet email');
    }
    const keyRecord = await prisma_1.default.activationKey.findUnique({
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
        throw new errorHandler_1.ValidationError('Clé d’activation invalide');
    }
    if (keyRecord.status !== 'ACTIVE' || keyRecord.isRedeemed) {
        throw new errorHandler_1.ValidationError('Cette clé d’activation a déjà été utilisée ou désactivée');
    }
    if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
        throw new errorHandler_1.ValidationError('Cette clé d’activation est expirée');
    }
    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
    const passwordHash = await bcryptjs_1.default.hash(password, saltRounds);
    const user = await prisma_1.default.user.create({
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
    const subscription = await prisma_1.default.subscription.create({
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
    await prisma_1.default.payment.create({
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
    await prisma_1.default.activationKey.update({
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
    await prisma_1.default.session.create({
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
router.post('/login', authRateLimit, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    // Recherche de l'utilisateur
    const user = await prisma_1.default.user.findUnique({
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
            lastLogin: true
        }
    });
    if (!user) {
        (0, logger_1.logAuthEvent)({
            action: 'login_failed',
            email,
            reason: 'user_not_found',
            ipAddress: req.ip,
            userAgent: req.get('User-Agent')
        });
        throw new errorHandler_1.AuthenticationError('Identifiants invalides');
    }
    // Vérifications de sécurité
    if (!user.isActive || user.isBlocked) {
        (0, logger_1.logAuthEvent)({
            action: 'login_failed',
            email,
            userId: user.id,
            reason: 'account_disabled',
            ipAddress: req.ip,
            userAgent: req.get('User-Agent')
        });
        throw new errorHandler_1.AuthenticationError('Compte désactivé');
    }
    // Vérification des tentatives de connexion
    await checkLoginAttempts(user);
    // Vérification du mot de passe
    const isValidPassword = await validatePassword(user, password);
    if (!isValidPassword) {
        // Incrémenter les tentatives
        await prisma_1.default.user.update({
            where: { id: user.id },
            data: {
                loginAttempts: user.loginAttempts + 1
            }
        });
        (0, logger_1.logAuthEvent)({
            action: 'login_failed',
            email,
            userId: user.id,
            reason: 'invalid_password',
            ipAddress: req.ip,
            userAgent: req.get('User-Agent')
        });
        throw new errorHandler_1.AuthenticationError('Identifiants invalides');
    }
    // Réinitialisation des tentatives et mise à jour de la dernière connexion
    await prisma_1.default.user.update({
        where: { id: user.id },
        data: {
            loginAttempts: 0,
            lockedUntil: null,
            lastLogin: new Date()
        }
    });
    // Création de la session
    const sessionId = generateSessionId(user.id);
    await prisma_1.default.session.create({
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
    (0, logger_1.logAuthEvent)({
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
const auth = auth_1.authenticateToken;
// POST /api/auth/logout
router.post('/logout', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const userId = req.user?.id;
    if (sessionId) {
        // Invalidation de la session
        await prisma_1.default.session.updateMany({
            where: { sessionId, isValid: true },
            data: { isValid: false }
        });
    }
    if (userId) {
        (0, logger_1.logAuthEvent)({
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
router.get('/me', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        throw new errorHandler_1.AuthenticationError();
    }
    const user = await prisma_1.default.user.findUnique({
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
        throw new errorHandler_1.AuthenticationError();
    }
    res.json({
        success: true,
        data: { user }
    });
}));
// POST /api/auth/change-password
router.post('/change-password', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        throw new errorHandler_1.AuthenticationError();
    }
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    // Récupération de l'utilisateur actuel
    const user = await prisma_1.default.user.findUnique({
        where: { id: userId },
        select: { id: true, passwordHash: true }
    });
    if (!user) {
        throw new errorHandler_1.AuthenticationError();
    }
    // Vérification du mot de passe actuel
    const isValidCurrentPassword = await bcryptjs_1.default.compare(currentPassword, user.passwordHash);
    if (!isValidCurrentPassword) {
        (0, logger_1.logSecurityEvent)({
            userId,
            action: 'password_change_failed',
            details: { reason: 'invalid_current_password' },
            ipAddress: req.ip,
            severity: 'warning'
        });
        throw new errorHandler_1.ValidationError('Mot de passe actuel incorrect');
    }
    // Hashage du nouveau mot de passe
    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
    const newPasswordHash = await bcryptjs_1.default.hash(newPassword, saltRounds);
    // Mise à jour du mot de passe
    await prisma_1.default.user.update({
        where: { id: userId },
        data: { passwordHash: newPasswordHash }
    });
    // Invalidation de toutes les sessions existantes
    await prisma_1.default.session.updateMany({
        where: { userId, isValid: true },
        data: { isValid: false }
    });
    (0, logger_1.logSecurityEvent)({
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
router.get('/sessions', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        throw new errorHandler_1.AuthenticationError();
    }
    const sessions = await prisma_1.default.session.findMany({
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
router.delete('/sessions/:sessionId', auth, (0, errorHandler_1.asyncHandler)(async (req, res) => {
    const userId = req.user?.id;
    const { sessionId } = req.params;
    if (!userId) {
        throw new errorHandler_1.AuthenticationError();
    }
    await prisma_1.default.session.updateMany({
        where: {
            sessionId,
            userId,
            isValid: true
        },
        data: { isValid: false }
    });
    (0, logger_1.logSecurityEvent)({
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
exports.default = router;
//# sourceMappingURL=auth.js.map