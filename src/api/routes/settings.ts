import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { asyncHandler, ValidationError, AuthorizationError, AppError } from '../../middleware/errorHandler';
import { requireMinimumRole, AuthenticatedRequest } from '../../middleware/auth';

const router = Router();

const adminOnly = requireMinimumRole('ADMIN');
const managerOrAdmin = requireMinimumRole('RESPONSABLE');
const referentOrAbove = requireMinimumRole('REFERENT');

// ─── Validation schemas ───────────────────────────────────────────────────────

const updateCompanySchema = z.object({
	name: z.string().min(2).optional(),
	siret: z.string().optional(),
	address: z.string().optional(),
	city: z.string().optional(),
	logoUrl: z.string().url().optional(),
});

const createAccountSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
	firstName: z.string().min(1),
	lastName: z.string().min(1),
	role: z.enum(['CAISSE', 'REFERENT', 'RESPONSABLE']),
	shopIds: z.array(z.string()).optional().default([]),
});

const updateAccountSchema = z.object({
	role: z.enum(['CAISSE', 'REFERENT', 'RESPONSABLE']).optional(),
	shopIds: z.array(z.string()).optional(),
	isActive: z.boolean().optional(),
	password: z.string().min(8).optional(),
});

const createShopSchema = z.object({
	name: z.string().min(1),
	code: z.string().optional(),
	address: z.string().optional(),
	city: z.string().optional(),
});

const updateShopSchema = z.object({
	name: z.string().min(1).optional(),
	code: z.string().optional(),
	address: z.string().optional(),
	city: z.string().optional(),
	isActive: z.boolean().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getCompanyOfUser(userId: string): Promise<string> {
	const user = await prisma.user.findUnique({
		where: { id: userId },
		select: { companyId: true, role: true },
	});
	if (user?.companyId) return user.companyId;

	// Admin sans company : fallback sur la première company de la base
	if (user?.role === 'ADMIN') {
		const first = await prisma.company.findFirst({ select: { id: true } });
		if (first) return first.id;
	}

	throw new AuthorizationError('Aucune société associée à ce compte');
}

function zodError(err: z.ZodError): string {
	return err.issues[0]?.message ?? 'Données invalides';
}

// ─── Company ──────────────────────────────────────────────────────────────────

router.get('/company', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	const [company, accountCount, shopCount] = await Promise.all([
		prisma.company.findUnique({ where: { id: companyId }, include: { subscription: true } }),
		prisma.user.count({ where: { companyId } }),
		prisma.shop.count({ where: { companyId } }),
	]);

	res.json({
		success: true,
		data: { company, usage: { accounts: accountCount, shops: shopCount } },
	});
}));

router.put('/company', managerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	const parsed = updateCompanySchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	const company = await prisma.company.update({
		where: { id: companyId },
		data: parsed.data,
		include: { subscription: true },
	});

	res.json({ success: true, data: company });
}));

// ─── Accounts ────────────────────────────────────────────────────────────────

router.get('/accounts', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	// REFERENT : ne voit que les comptes des boutiques qui lui sont assignées
	let whereClause: any = { companyId };
	if (req.user!.role === 'REFERENT') {
		const referent = await prisma.user.findUnique({
			where: { id: req.user!.id },
			select: { shopIds: true },
		});
		const myShopIds = referent?.shopIds ?? [];
		if (myShopIds.length > 0) {
			whereClause = { companyId, shopIds: { hasSome: myShopIds } };
		} else {
			// Référent sans boutique assignée : ne voit aucun compte
			return res.json({ success: true, data: [] });
		}
	}

	const accounts = await prisma.user.findMany({
		where: whereClause,
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
			shops: { select: { id: true, name: true, code: true } },
		},
		orderBy: { createdAt: 'asc' },
	});

	res.json({ success: true, data: accounts });
}));

router.post('/accounts', referentOrAbove, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);
	const callerRole = req.user!.role;

	const parsed = createAccountSchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	// REFERENT : ne peut créer que des comptes CAISSE pour ses boutiques
	if (callerRole === 'REFERENT') {
		if (parsed.data.role !== 'CAISSE') {
			throw new AuthorizationError('Un Référent ne peut créer que des comptes Caisse');
		}

		const referent = await prisma.user.findUnique({
			where: { id: req.user!.id },
			select: { shopIds: true },
		});
		const myShopIds = referent?.shopIds ?? [];

		if (myShopIds.length === 0) {
			throw new AuthorizationError('Vous n\'êtes assigné à aucune boutique');
		}

		// Forcer l'assignation aux boutiques du référent (ou valider le subset fourni)
		const requestedShops = parsed.data.shopIds.length > 0 ? parsed.data.shopIds : myShopIds;
		const invalidShops = requestedShops.filter((id: string) => !myShopIds.includes(id));
		if (invalidShops.length > 0) {
			throw new AuthorizationError('Vous ne pouvez assigner un compte qu\'aux boutiques dont vous êtes référent');
		}
		parsed.data.shopIds = requestedShops;
	}

	// RESPONSABLE ne peut pas créer d'autres RESPONSABLE
	if (callerRole === 'RESPONSABLE' && parsed.data.role === 'RESPONSABLE') {
		throw new AuthorizationError('Un Responsable ne peut pas créer un autre compte Responsable');
	}

	const subscription = await prisma.subscription.findUnique({ where: { companyId } });
	const maxAccounts = subscription?.maxAccounts ?? 3;
	const currentCount = await prisma.user.count({ where: { companyId } });

	if (maxAccounts !== -1 && currentCount >= maxAccounts) {
		throw new AppError(`Limite d'abonnement atteinte (${maxAccounts} comptes maximum)`, 402);
	}

	const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
	if (existing) throw new ValidationError('Un compte avec cet email existe déjà');

	const passwordHash = await bcrypt.hash(parsed.data.password, 12);

	const account = await prisma.user.create({
		data: {
			email: parsed.data.email,
			passwordHash,
			firstName: parsed.data.firstName,
			lastName: parsed.data.lastName,
			role: parsed.data.role,
			companyId,
			shopIds: parsed.data.shopIds,
		},
		select: {
			id: true, email: true, firstName: true, lastName: true,
			role: true, isActive: true, createdAt: true, shopIds: true,
			shops: { select: { id: true, name: true, code: true } },
		},
	});

	res.status(201).json({ success: true, data: account });
}));

router.put('/accounts/:id', managerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	const target = await prisma.user.findFirst({ where: { id: req.params.id, companyId } });
	if (!target) throw new AuthorizationError('Compte introuvable dans votre société');

	const parsed = updateAccountSchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	// RESPONSABLE ne peut pas promouvoir un compte au rang RESPONSABLE
	if (req.user!.role === 'RESPONSABLE' && parsed.data.role === 'RESPONSABLE') {
		throw new AuthorizationError('Un Responsable ne peut pas promouvoir un compte au rang Responsable');
	}

	const updateData: {
		role?: string;
		shopIds?: string[];
		isActive?: boolean;
		passwordHash?: string;
	} = {};

	if (parsed.data.role !== undefined) updateData.role = parsed.data.role;
	if (parsed.data.shopIds !== undefined) updateData.shopIds = parsed.data.shopIds;
	if (parsed.data.isActive !== undefined) updateData.isActive = parsed.data.isActive;
	if (parsed.data.password) updateData.passwordHash = await bcrypt.hash(parsed.data.password, 12);

	const account = await prisma.user.update({
		where: { id: req.params.id },
		data: updateData as any,
		select: {
			id: true, email: true, firstName: true, lastName: true,
			role: true, isActive: true, shopIds: true,
			shops: { select: { id: true, name: true, code: true } },
		},
	});

	res.json({ success: true, data: account });
}));

router.delete('/accounts/:id', managerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	if (req.params.id === req.user!.id) throw new ValidationError('Impossible de supprimer son propre compte');

	const companyId = await getCompanyOfUser(req.user!.id);
	const target = await prisma.user.findFirst({ where: { id: req.params.id, companyId } });
	if (!target) throw new AuthorizationError('Compte introuvable dans votre société');

	await prisma.user.delete({ where: { id: req.params.id } });

	res.json({ success: true, message: 'Compte supprimé' });
}));

// ─── Shops ────────────────────────────────────────────────────────────────────

router.get('/shops', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	const shops = await prisma.shop.findMany({
		where: { companyId },
		include: {
			users: { select: { id: true, firstName: true, lastName: true, role: true } },
		},
		orderBy: { createdAt: 'asc' },
	});

	res.json({ success: true, data: shops });
}));

router.post('/shops', managerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	const parsed = createShopSchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	const subscription = await prisma.subscription.findUnique({ where: { companyId } });
	const maxShops = subscription?.maxShops ?? 1;
	const currentCount = await prisma.shop.count({ where: { companyId } });

	if (maxShops !== -1 && currentCount >= maxShops) {
		throw new AppError(`Limite d'abonnement atteinte (${maxShops} shops maximum)`, 402);
	}

	if (parsed.data.code) {
		const dup = await prisma.shop.findFirst({ where: { companyId, code: parsed.data.code } });
		if (dup) throw new ValidationError('Un shop avec ce code existe déjà');
	}

	const shop = await prisma.shop.create({
		data: { ...parsed.data, companyId },
		include: { users: { select: { id: true, firstName: true, lastName: true, role: true } } },
	});

	res.status(201).json({ success: true, data: shop });
}));

router.put('/shops/:id', managerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	const shop = await prisma.shop.findFirst({ where: { id: req.params.id, companyId } });
	if (!shop) throw new AuthorizationError('Shop introuvable dans votre société');

	const parsed = updateShopSchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	if (parsed.data.code && parsed.data.code !== shop.code) {
		const dup = await prisma.shop.findFirst({
			where: { companyId, code: parsed.data.code, id: { not: req.params.id } },
		});
		if (dup) throw new ValidationError('Un shop avec ce code existe déjà');
	}

	const updated = await prisma.shop.update({
		where: { id: req.params.id },
		data: parsed.data,
		include: { users: { select: { id: true, firstName: true, lastName: true, role: true } } },
	});

	res.json({ success: true, data: updated });
}));

router.delete('/shops/:id', managerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	const shop = await prisma.shop.findFirst({ where: { id: req.params.id, companyId } });
	if (!shop) throw new AuthorizationError('Shop introuvable dans votre société');

	// Remove this shop from all users' shopIds arrays
	const affected = await prisma.user.findMany({
		where: { companyId, shopIds: { has: req.params.id } },
		select: { id: true, shopIds: true },
	});
	await Promise.all(
		affected.map((u: { id: string; shopIds: string[] }) =>
			prisma.user.update({
				where: { id: u.id },
				data: { shopIds: u.shopIds.filter((sid: string) => sid !== req.params.id) },
			})
		)
	);

	await prisma.shop.delete({ where: { id: req.params.id } });

	res.json({ success: true, message: 'Shop supprimé' });
}));

// ─── Subscription ────────────────────────────────────────────────────────────

router.get('/subscription', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	const [subscription, accountCount, shopCount] = await Promise.all([
		prisma.subscription.findUnique({ where: { companyId } }),
		prisma.user.count({ where: { companyId } }),
		prisma.shop.count({ where: { companyId } }),
	]);

	res.json({
		success: true,
		data: {
			subscription,
			usage: {
				accounts: accountCount,
				accountsMax: subscription?.maxAccounts ?? -1,
				shops: shopCount,
				shopsMax: subscription?.maxShops ?? -1,
			},
		},
	});
}));

const updateSubscriptionSchema = z.object({
	maxAccounts: z.number().int().min(-1).optional(),
	maxShops: z.number().int().min(-1).optional(),
	features: z.array(z.string()).optional(),
});

router.put('/subscription', managerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const companyId = await getCompanyOfUser(req.user!.id);

	const parsed = updateSubscriptionSchema.safeParse(req.body);
	if (!parsed.success) throw new ValidationError(zodError(parsed.error));

	const subscription = await prisma.subscription.update({
		where: { companyId },
		data: parsed.data,
	});

	res.json({ success: true, data: subscription });
}));

export default router;
