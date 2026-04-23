import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';
import { asyncHandler, AuthorizationError, ValidationError } from '../../middleware/errorHandler';
import { AuthenticatedRequest } from '../../middleware/auth';

const router = Router();

const SUBSCRIPTION_STATUSES = ['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;
const PAYMENT_STATUSES = ['PENDING', 'PAID', 'VERIFIED', 'FAILED', 'REFUNDED'] as const;

function requireBusinessManager(req: AuthenticatedRequest): void {
	const role = req.user?.role;
	if (!role || !['ADMIN', 'RESPONSABLE'].includes(role)) {
		throw new AuthorizationError('Accès réservé à la gestion business');
	}
}

router.get('/stats', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const user = req.user!;
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const fourteenDaysAhead = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

	const [
		dossiersAujourdhui,
		attenteValidation,
		enCours,
		exceptionsEnAttente,
		scoringCritique,
		dossiersValides30j,
		totalDossiers30j,
		mesExceptions,
		recentDossiers,
	] = await Promise.all([
		prisma.dossier.count({ where: { createdAt: { gte: today } } }),
		prisma.dossier.count({ where: { status: 'ATTENTE_VALIDATION' } }),
		prisma.dossier.count({ where: { status: 'EN_COURS' } }),
		prisma.exception.count({ where: { status: { in: ['EN_ATTENTE', 'EN_COURS_TRAITEMENT'] } } }),
		prisma.scoring.count({ where: { niveau: 'CRITIQUE' } }),
		prisma.dossier.count({ where: { status: 'VALIDE', updatedAt: { gte: thirtyDaysAgo } } }),
		prisma.dossier.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
		prisma.exception.count({ where: { assignedToId: user.id, status: { in: ['EN_ATTENTE', 'EN_COURS_TRAITEMENT'] } } }),
		prisma.dossier.findMany({
			take: 5,
			orderBy: { updatedAt: 'desc' },
			include: { client: { select: { nom: true, prenom: true } } },
		}),
	]);

	// Queries sur les modèles billing
	const subscriptions = await prisma.subscription.findMany({
		orderBy: { updatedAt: 'desc' },
		include: {
			company: { select: { name: true } },
			owner: { select: { id: true, firstName: true, lastName: true, email: true } },
		},
	});

	const payments = await prisma.payment.findMany({
		orderBy: { paidAt: 'desc' },
		include: {
			subscription: { select: { id: true, companyName: true, plan: true, status: true } },
			user: { select: { id: true, firstName: true, lastName: true, email: true } },
		},
	});

	const activationKeys = await prisma.activationKey.findMany({
		orderBy: { createdAt: 'desc' },
		include: {
			redeemedByUser: { select: { id: true, firstName: true, lastName: true, email: true } },
		},
	});

	const tauxValidation = totalDossiers30j > 0
		? Math.round((dossiersValides30j / totalDossiers30j) * 100)
		: 0;

	type SubWithRelations = typeof subscriptions[number];
	type PaymentWithRelations = typeof payments[number];
	type KeyWithRelations = typeof activationKeys[number];

	const activeSubscriptions = subscriptions.filter((s: SubWithRelations) => s.status === 'ACTIVE');
	const subscriptionsExpiringSoon = subscriptions.filter((s: SubWithRelations) =>
		s.status === 'ACTIVE' &&
		s.currentPeriodEnd &&
		new Date(s.currentPeriodEnd) <= fourteenDaysAhead
	).length;
	const paymentsPendingReview = payments.filter((p: PaymentWithRelations) => ['PENDING', 'PAID'].includes(p.status)).length;
	const availableActivationKeys = activationKeys.filter((k: KeyWithRelations) => k.status === 'ACTIVE' && !k.isRedeemed).length;
	const redeemedActivationKeys = activationKeys.filter((k: KeyWithRelations) => k.isRedeemed).length;
	const monthlyRecurringRevenue = activeSubscriptions.reduce((sum: number, s: SubWithRelations) => {
		const priceCents = s.priceCents || 0;
		return sum + (s.billingCycle === 'YEARLY' ? Math.round(priceCents / 12) : priceCents);
	}, 0);
	const revenueLast30Days = payments
		.filter((p: PaymentWithRelations) => p.paidAt && new Date(p.paidAt) >= thirtyDaysAgo && ['PAID', 'VERIFIED'].includes(p.status))
		.reduce((sum: number, p: PaymentWithRelations) => sum + (p.amountCents || 0), 0);

	res.json({
		success: true,
		data: {
			kpis: {
				dossiersAujourdhui,
				attenteValidation,
				enCours,
				exceptionsEnAttente,
				scoringCritique,
				tauxValidation,
				mesExceptions,
			},
			monitoring: {
				activeSubscriptions: activeSubscriptions.length,
				subscriptionsExpiringSoon,
				paymentsPendingReview,
				availableActivationKeys,
				redeemedActivationKeys,
				monthlyRecurringRevenueCents: monthlyRecurringRevenue,
				revenueLast30DaysCents: revenueLast30Days,
			},
			recentDossiers: recentDossiers.map((d: typeof recentDossiers[number]) => ({
				id: d.id,
				numero: d.numero,
				status: d.status,
				typeOuverture: d.typeOuverture,
				montantInitial: d.montantInitial,
				client: `${d.client?.prenom || ''} ${d.client?.nom || ''}`.trim(),
				updatedAt: d.updatedAt,
			})),
			subscriptions: subscriptions.slice(0, 50).map((s: SubWithRelations) => ({
				id: s.id,
				companyId: s.companyId,
				companyName: s.companyName ?? s.company?.name,
				plan: s.plan,
				billingCycle: s.billingCycle,
				status: s.status,
				priceCents: s.priceCents,
				currency: s.currency,
				seats: s.seats,
				maxAccounts: s.maxAccounts,
				maxShops: s.maxShops,
				features: s.features ?? [],
				currentPeriodStart: s.currentPeriodStart,
				currentPeriodEnd: s.currentPeriodEnd ?? s.expiresAt,
				owner: s.owner,
			})),
			recentPayments: payments.slice(0, 8).map((p: PaymentWithRelations) => ({
				id: p.id,
				reference: p.reference,
				amountCents: p.amountCents,
				currency: p.currency,
				status: p.status,
				method: p.method,
				description: p.description,
				paidAt: p.paidAt,
				subscription: p.subscription,
				user: p.user,
			})),
			activationKeys: activationKeys.slice(0, 8).map((k: KeyWithRelations) => ({
				id: k.id,
				code: k.code,
				label: k.label,
				plan: k.plan,
				billingCycle: k.billingCycle,
				priceCents: k.priceCents,
				currency: k.currency,
				status: k.status,
				isRedeemed: k.isRedeemed,
				redeemedAt: k.redeemedAt,
				redeemedByUser: k.redeemedByUser,
			})),
		},
	});
}));

router.patch('/payments/:id/status', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireBusinessManager(req);

	const { id } = req.params;
	const nextStatus = String(req.body?.status || '').toUpperCase();

	if (!PAYMENT_STATUSES.includes(nextStatus as typeof PAYMENT_STATUSES[number])) {
		throw new ValidationError('Statut de paiement invalide');
	}

	const payment = await prisma.payment.update({
		where: { id },
		data: {
			status: nextStatus,
			verifiedAt: nextStatus === 'VERIFIED' ? new Date() : null,
		},
	});

	res.json({
		success: true,
		message: 'Statut du paiement mis à jour',
		data: { payment }
	});
}));

router.patch('/subscriptions/:id/status', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireBusinessManager(req);

	const { id } = req.params;
	const nextStatus = String(req.body?.status || '').toUpperCase();

	if (!SUBSCRIPTION_STATUSES.includes(nextStatus as typeof SUBSCRIPTION_STATUSES[number])) {
		throw new ValidationError('Statut d\'abonnement invalide');
	}

	const subscription = await prisma.subscription.update({
		where: { id },
		data: {
			status: nextStatus as any,
			cancelledAt: nextStatus === 'CANCELLED' ? new Date() : undefined,
		},
	});

	res.json({
		success: true,
		message: 'Statut de l\'abonnement mis à jour',
		data: { subscription }
	});
}));

// ── Admin only ─────────────────────────────────────────────────────────────────

function requireAdmin(req: AuthenticatedRequest): void {
	if (req.user?.role !== 'ADMIN') {
		throw new AuthorizationError('Accès réservé à l\'administrateur');
	}
}

// POST /subscriptions — créer un abonnement + company
router.post('/subscriptions', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { companyName, plan, billingCycle, priceCents, seats, maxAccounts, maxShops, features, currentPeriodStart, currentPeriodEnd } = req.body;

	if (!companyName?.trim()) throw new ValidationError('companyName requis');
	if (!plan?.trim()) throw new ValidationError('plan requis');

	const company = await prisma.company.create({ data: { name: companyName.trim() } });

	const subscription = await prisma.subscription.create({
		data: {
			companyId: company.id,
			companyName: companyName.trim(),
			plan: plan.toUpperCase() as any,
			billingCycle: ['MONTHLY', 'YEARLY'].includes(String(billingCycle).toUpperCase()) ? String(billingCycle).toUpperCase() : 'MONTHLY',
			status: 'ACTIVE',
			priceCents: Number(priceCents) || 0,
			currency: 'EUR',
			seats: Math.max(1, Number(seats) || 1),
			maxAccounts: maxAccounts !== undefined ? Number(maxAccounts) : 5,
			maxShops: maxShops !== undefined ? Number(maxShops) : 1,
			features: Array.isArray(features) ? features : [],
			currentPeriodStart: currentPeriodStart ? new Date(currentPeriodStart) : new Date(),
			currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
		},
	});

	res.status(201).json({ success: true, message: 'Abonnement créé', data: { subscription } });
}));

// PUT /subscriptions/:id — modifier un abonnement (tous champs)
router.put('/subscriptions/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;
	const { companyName, plan, billingCycle, priceCents, seats, maxAccounts, maxShops, features, currentPeriodStart, currentPeriodEnd, status } = req.body;

	const patch: Record<string, any> = {};
	if (companyName !== undefined) patch.companyName = companyName;
	if (plan !== undefined) patch.plan = String(plan).toUpperCase();
	if (billingCycle !== undefined) patch.billingCycle = String(billingCycle).toUpperCase();
	if (priceCents !== undefined) patch.priceCents = Number(priceCents);
	if (seats !== undefined) patch.seats = Number(seats);
	if (maxAccounts !== undefined) patch.maxAccounts = Number(maxAccounts);
	if (maxShops !== undefined) patch.maxShops = Number(maxShops);
	if (features !== undefined) patch.features = Array.isArray(features) ? features : [];
	if (currentPeriodStart !== undefined) patch.currentPeriodStart = new Date(currentPeriodStart);
	if (currentPeriodEnd !== undefined) patch.currentPeriodEnd = new Date(currentPeriodEnd);
	if (status !== undefined) {
		const s = String(status).toUpperCase();
		if (SUBSCRIPTION_STATUSES.includes(s as any)) {
			patch.status = s;
			if (s === 'CANCELLED') patch.cancelledAt = new Date();
		}
	}

	const subscription = await prisma.subscription.update({ where: { id }, data: patch });

	// Synchroniser company.name si companyName est fourni
	if (companyName !== undefined && subscription.companyId) {
		await prisma.company.update({
			where: { id: subscription.companyId },
			data: { name: companyName },
		});
	}

	res.json({ success: true, message: 'Abonnement mis à jour', data: { subscription } });
}));

// DELETE /subscriptions/:id
router.delete('/subscriptions/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;
	await prisma.subscription.delete({ where: { id } });
	res.json({ success: true, message: 'Abonnement supprimé' });
}));

// GET /subscriptions/:id/shops — boutiques d'un abonnement
router.get('/subscriptions/:id/shops', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;
	const sub = await prisma.subscription.findUnique({ where: { id }, select: { companyId: true } });
	if (!sub) throw new ValidationError('Abonnement introuvable');

	const shops = await prisma.shop.findMany({
		where: { companyId: sub.companyId },
		orderBy: { createdAt: 'asc' },
		include: { users: { select: { id: true, firstName: true, lastName: true } } },
	});
	res.json({ success: true, data: { shops } });
}));

// POST /subscriptions/:id/shops — créer une boutique
router.post('/subscriptions/:id/shops', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;
	const { name, code, address, city } = req.body;
	if (!name?.trim()) throw new ValidationError('Le nom de la boutique est requis');

	const sub = await prisma.subscription.findUnique({ where: { id }, select: { companyId: true, maxShops: true } });
	if (!sub) throw new ValidationError('Abonnement introuvable');

	if (sub.maxShops !== -1) {
		const count = await prisma.shop.count({ where: { companyId: sub.companyId } });
		if (count >= sub.maxShops) throw new ValidationError(`Limite de ${sub.maxShops} boutique(s) atteinte`);
	}

	if (code?.trim()) {
		const dup = await prisma.shop.findFirst({ where: { companyId: sub.companyId, code: code.trim() } });
		if (dup) throw new ValidationError('Un shop avec ce code existe déjà');
	}

	const shop = await prisma.shop.create({
		data: {
			name: name.trim(),
			code: code?.trim() || undefined,
			address: address?.trim() || undefined,
			city: city?.trim() || undefined,
			companyId: sub.companyId,
		},
		include: { users: { select: { id: true, firstName: true, lastName: true } } },
	});
	res.status(201).json({ success: true, message: 'Boutique créée', data: { shop } });
}));

// PUT /shops/:id — modifier une boutique
router.put('/shops/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;
	const { name, code, address, city, isActive } = req.body;

	const existing = await prisma.shop.findUnique({ where: { id }, select: { companyId: true, code: true } });
	if (!existing) throw new ValidationError('Boutique introuvable');

	if (code !== undefined && code !== existing.code) {
		const dup = await prisma.shop.findFirst({ where: { companyId: existing.companyId, code, id: { not: id } } });
		if (dup) throw new ValidationError('Un shop avec ce code existe déjà');
	}

	const patch: Record<string, any> = {};
	if (name !== undefined) patch.name = name;
	if (code !== undefined) patch.code = code || null;
	if (address !== undefined) patch.address = address || null;
	if (city !== undefined) patch.city = city || null;
	if (isActive !== undefined) patch.isActive = Boolean(isActive);

	const shop = await prisma.shop.update({
		where: { id },
		data: patch,
		include: { users: { select: { id: true, firstName: true, lastName: true } } },
	});
	res.json({ success: true, message: 'Boutique mise à jour', data: { shop } });
}));

// DELETE /shops/:id — supprimer une boutique
router.delete('/shops/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;

	const shop = await prisma.shop.findUnique({ where: { id }, select: { companyId: true } });
	if (shop) {
		const users = await prisma.user.findMany({ where: { companyId: shop.companyId }, select: { id: true, shopIds: true } });
		await Promise.all(
			users
				.filter((u: typeof users[number]) => u.shopIds?.includes(id))
				.map((u: typeof users[number]) => prisma.user.update({ where: { id: u.id }, data: { shopIds: u.shopIds.filter((s: string) => s !== id) } }))
		);
	}
	await prisma.shop.delete({ where: { id } });
	res.json({ success: true, message: 'Boutique supprimée' });
}));

// ── Users par abonnement ───────────────────────────────────────────────────────

// GET /subscriptions/:id/users
router.get('/subscriptions/:id/users', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;
	const sub = await prisma.subscription.findUnique({ where: { id }, select: { companyId: true } });
	if (!sub) throw new ValidationError('Abonnement introuvable');

	const users = await prisma.user.findMany({
		where: { companyId: sub.companyId },
		select: {
			id: true, email: true, firstName: true, lastName: true,
			role: true, isActive: true, isBlocked: true, lastLogin: true, createdAt: true,
			shops: { select: { id: true, name: true } },
		},
		orderBy: { createdAt: 'asc' },
	});

	res.json({ success: true, data: { users } });
}));

// POST /subscriptions/:id/users — créer un utilisateur
router.post('/subscriptions/:id/users', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;
	const { email, password, firstName, lastName, role } = req.body;

	if (!email?.trim()) throw new ValidationError('Email requis');
	if (!password || password.length < 8) throw new ValidationError('Mot de passe requis (8 caractères minimum)');
	if (!firstName?.trim()) throw new ValidationError('Prénom requis');
	if (!lastName?.trim()) throw new ValidationError('Nom requis');

	const sub = await prisma.subscription.findUnique({
		where: { id },
		select: { companyId: true, maxAccounts: true },
	});
	if (!sub) throw new ValidationError('Abonnement introuvable');

	if (sub.maxAccounts !== -1) {
		const count = await prisma.user.count({ where: { companyId: sub.companyId } });
		if (count >= sub.maxAccounts) throw new ValidationError(`Limite de ${sub.maxAccounts} compte(s) atteinte`);
	}

	const existing = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
	if (existing) throw new ValidationError('Un compte avec cet email existe déjà');

	const passwordHash = await bcrypt.hash(password, 12);
	const user = await prisma.user.create({
		data: {
			email: email.trim().toLowerCase(),
			passwordHash,
			firstName: firstName.trim(),
			lastName: lastName.trim(),
			role: role || 'CAISSE',
			companyId: sub.companyId,
		},
		select: {
			id: true, email: true, firstName: true, lastName: true,
			role: true, isActive: true, createdAt: true,
		},
	});

	res.status(201).json({ success: true, data: { user } });
}));

// PUT /users/:id — modifier un utilisateur
router.put('/users/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;
	const { role, isActive, password } = req.body;

	const patch: Record<string, any> = {};
	if (role !== undefined) patch.role = role;
	if (isActive !== undefined) patch.isActive = Boolean(isActive);
	if (password) {
		if (password.length < 8) throw new ValidationError('Mot de passe trop court (8 caractères minimum)');
		patch.passwordHash = await bcrypt.hash(password, 12);
	}

	const user = await prisma.user.update({
		where: { id },
		data: patch,
		select: {
			id: true, email: true, firstName: true, lastName: true,
			role: true, isActive: true,
		},
	});

	res.json({ success: true, data: { user } });
}));

// DELETE /users/:id — supprimer un utilisateur
router.delete('/users/:id', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	requireAdmin(req);
	const { id } = req.params;

	if (id === req.user!.id) throw new ValidationError('Impossible de supprimer son propre compte');

	await prisma.user.delete({ where: { id } });
	res.json({ success: true, message: 'Utilisateur supprimé' });
}));

export default router;
