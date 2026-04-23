import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import {
	asyncHandler,
	ValidationError,
	AuthorizationError,
	AppError,
} from '../../middleware/errorHandler';
import { requireMinimumRole, AuthenticatedRequest } from '../../middleware/auth';

const router = Router();
const adminOnly = requireMinimumRole('ADMIN');

// Toutes les routes de ce fichier sont ADMIN uniquement
router.use(adminOnly as any);

// ─── Validation schemas ───────────────────────────────────────────────────────

const createCompanySchema = z.object({
	// Company
	companyName: z.string().min(2, 'Nom de société requis'),
	siret: z.string().optional(),
	address: z.string().optional(),
	city: z.string().optional(),
	// Subscription
	plan: z.enum(['STARTER', 'PRO', 'BUSINESS', 'ENTERPRISE']).default('PRO'),
	status: z.enum(['TRIAL', 'ACTIVE', 'EXPIRED', 'SUSPENDED', 'PAST_DUE', 'CANCELLED']).default('TRIAL'),
	billingCycle: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'),
	maxAccounts: z.number().int().min(-1).default(10),
	maxShops: z.number().int().min(-1).default(2),
	seats: z.number().int().min(1).default(1),
	priceCents: z.number().int().min(0).default(0),
	features: z.array(z.string()).default([]),
});

const updateCompanySchema = z.object({
	name: z.string().min(2).optional(),
	siret: z.string().optional(),
	address: z.string().optional(),
	city: z.string().optional(),
	logoUrl: z.string().url().optional(),
});

const updateSubscriptionSchema = z.object({
	plan: z.enum(['STARTER', 'PRO', 'BUSINESS', 'ENTERPRISE']).optional(),
	status: z.enum(['TRIAL', 'ACTIVE', 'EXPIRED', 'SUSPENDED', 'PAST_DUE', 'CANCELLED']).optional(),
	billingCycle: z.enum(['MONTHLY', 'YEARLY']).optional(),
	maxAccounts: z.number().int().min(-1).optional(),
	maxShops: z.number().int().min(-1).optional(),
	seats: z.number().int().min(1).optional(),
	priceCents: z.number().int().min(0).optional(),
	features: z.array(z.string()).optional(),
});

const createResponsableSchema = z.object({
	email: z.string().email('Email invalide'),
	password: z.string().min(8, 'Mot de passe minimum 8 caractères'),
	firstName: z.string().min(1, 'Prénom requis'),
	lastName: z.string().min(1, 'Nom requis'),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function zodError(err: z.ZodError): string {
	return err.issues[0]?.message ?? 'Données invalides';
}

// ─── GET /admin/companies ─────────────────────────────────────────────────────
// Lister toutes les companies avec leur abonnement et statistiques

router.get('/companies', asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
	const companies = await prisma.company.findMany({
		include: {
			subscription: true,
			_count: {
				select: { users: true, shops: true },
			},
		},
		orderBy: { createdAt: 'desc' },
	});

	res.json({ success: true, data: companies });
}));

// ─── POST /admin/companies ────────────────────────────────────────────────────
// Créer une company + subscription SANS compte utilisateur

router.post('/companies', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const parsed = createCompanySchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	const d = parsed.data;

	const periodStart = new Date();
	const periodEnd = new Date();
	if (d.billingCycle === 'YEARLY') {
		periodEnd.setFullYear(periodEnd.getFullYear() + 1);
	} else {
		periodEnd.setMonth(periodEnd.getMonth() + 1);
	}

	const company = await prisma.company.create({
		data: {
			id: generateId(),
			name: d.companyName,
			siret: d.siret,
			address: d.address,
			city: d.city,
		},
	});

	const subscription = await prisma.subscription.create({
		data: {
			id: generateId(),
			companyId: company.id,
			plan: d.plan,
			status: d.status,
			billingCycle: d.billingCycle,
			maxAccounts: d.maxAccounts,
			maxShops: d.maxShops,
			seats: d.seats,
			priceCents: d.priceCents,
			currency: 'EUR',
			features: d.features,
			currentPeriodStart: periodStart,
			currentPeriodEnd: periodEnd,
		},
	});

	res.status(201).json({ success: true, data: { company, subscription } });
}));

// ─── GET /admin/companies/:id ─────────────────────────────────────────────────

router.get('/companies/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const company = await prisma.company.findUnique({
		where: { id: req.params.id },
		include: {
			subscription: true,
			shops: true,
			users: {
				select: {
					id: true,
					email: true,
					firstName: true,
					lastName: true,
					role: true,
					isActive: true,
					isBlocked: true,
					lastLogin: true,
					createdAt: true,
					shopIds: true,
				},
			},
		},
	});

	if (!company) throw new AppError('Société introuvable', 404);

	res.json({ success: true, data: company });
}));

// ─── PUT /admin/companies/:id ─────────────────────────────────────────────────

router.put('/companies/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const parsed = updateCompanySchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	const exists = await prisma.company.findUnique({ where: { id: req.params.id } });
	if (!exists) throw new AppError('Société introuvable', 404);

	const company = await prisma.company.update({
		where: { id: req.params.id },
		data: parsed.data,
		include: { subscription: true },
	});

	res.json({ success: true, data: company });
}));

// ─── PUT /admin/companies/:id/subscription ────────────────────────────────────

router.put('/companies/:id/subscription', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const parsed = updateSubscriptionSchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	const exists = await prisma.subscription.findUnique({ where: { companyId: req.params.id } });
	if (!exists) throw new AppError('Abonnement introuvable pour cette société', 404);

	const subscription = await prisma.subscription.update({
		where: { companyId: req.params.id },
		data: parsed.data,
	});

	res.json({ success: true, data: subscription });
}));

// ─── DELETE /admin/companies/:id ──────────────────────────────────────────────

router.delete('/companies/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const company = await prisma.company.findUnique({
		where: { id: req.params.id },
		include: { _count: { select: { users: true } } },
	});
	if (!company) throw new AppError('Société introuvable', 404);

	if ((company._count as any).users > 0) {
		throw new AppError(
			`Impossible de supprimer : ${(company._count as any).users} compte(s) actif(s) dans cette société. Supprimez d'abord les comptes.`,
			409
		);
	}

	// Suppression en cascade : subscription + shops + company
	await prisma.subscription.deleteMany({ where: { companyId: req.params.id } });
	await prisma.shop.deleteMany({ where: { companyId: req.params.id } });
	await prisma.company.delete({ where: { id: req.params.id } });

	res.json({ success: true, message: 'Société et abonnement supprimés' });
}));

// ─── POST /admin/companies/:id/responsable ────────────────────────────────────
// Créer le compte RESPONSABLE d'un abonnement existant
// (Étape 2 — implémentée ici car dépend du même contexte admin/company)

router.post('/companies/:id/responsable', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const parsed = createResponsableSchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	const company = await prisma.company.findUnique({
		where: { id: req.params.id },
		include: { subscription: true },
	});
	if (!company) throw new AppError('Société introuvable', 404);
	if (!company.subscription) throw new AppError('Cette société n\'a pas encore d\'abonnement', 409);

	// Vérifier qu'il n'existe pas déjà un RESPONSABLE pour cette company
	const existingResponsable = await prisma.user.findFirst({
		where: { companyId: req.params.id, role: 'RESPONSABLE' },
	});
	if (existingResponsable) {
		throw new ValidationError(
			`Un compte RESPONSABLE existe déjà pour cette société (${existingResponsable.email})`
		);
	}

	// Vérifier que l'email n'est pas déjà utilisé
	const emailTaken = await prisma.user.findUnique({ where: { email: parsed.data.email } });
	if (emailTaken) throw new ValidationError('Un compte avec cet email existe déjà');

	// Vérifier la limite de comptes de l'abonnement
	const maxAccounts = company.subscription.maxAccounts;
	const currentCount = await prisma.user.count({ where: { companyId: req.params.id } });
	if (maxAccounts !== -1 && currentCount >= maxAccounts) {
		throw new AppError(`Limite d'abonnement atteinte (${maxAccounts} comptes maximum)`, 402);
	}

	const passwordHash = await bcrypt.hash(parsed.data.password, 12);

	const responsable = await prisma.user.create({
		data: {
			id: generateId(),
			email: parsed.data.email,
			passwordHash,
			firstName: parsed.data.firstName,
			lastName: parsed.data.lastName,
			role: 'RESPONSABLE',
			companyId: req.params.id,
		},
		select: {
			id: true,
			email: true,
			firstName: true,
			lastName: true,
			role: true,
			isActive: true,
			createdAt: true,
		},
	});

	res.status(201).json({ success: true, data: responsable });
}));

export default router;
