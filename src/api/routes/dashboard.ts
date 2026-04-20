import { Router, Response } from 'express';
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
		subscriptions,
		payments,
		activationKeys,
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
		(prisma as any).subscription.findMany({
			orderBy: { updatedAt: 'desc' },
			include: {
				owner: { select: { id: true, firstName: true, lastName: true, email: true } },
			},
		}),
		(prisma as any).payment.findMany({
			orderBy: { paidAt: 'desc' },
			include: {
				subscription: { select: { id: true, companyName: true, plan: true, status: true } },
				user: { select: { id: true, firstName: true, lastName: true, email: true } },
			},
		}),
		(prisma as any).activationKey.findMany({
			orderBy: { createdAt: 'desc' },
			include: {
				redeemedByUser: { select: { id: true, firstName: true, lastName: true, email: true } },
			},
		}),
	]);

	const tauxValidation = totalDossiers30j > 0
		? Math.round((dossiersValides30j / totalDossiers30j) * 100)
		: 0;

	const activeSubscriptions = subscriptions.filter((subscription: any) => subscription.status === 'ACTIVE');
	const subscriptionsExpiringSoon = subscriptions.filter((subscription: any) =>
		subscription.status === 'ACTIVE' &&
		subscription.currentPeriodEnd &&
		new Date(subscription.currentPeriodEnd) <= fourteenDaysAhead
	).length;
	const paymentsPendingReview = payments.filter((payment: any) => ['PENDING', 'PAID'].includes(payment.status)).length;
	const availableActivationKeys = activationKeys.filter((key: any) => key.status === 'ACTIVE' && !key.isRedeemed).length;
	const redeemedActivationKeys = activationKeys.filter((key: any) => key.isRedeemed).length;
	const monthlyRecurringRevenue = activeSubscriptions.reduce((sum: number, subscription: any) => {
		const priceCents = subscription.priceCents || 0;
		return sum + (subscription.billingCycle === 'YEARLY' ? Math.round(priceCents / 12) : priceCents);
	}, 0);
	const revenueLast30Days = payments
		.filter((payment: any) => payment.paidAt && new Date(payment.paidAt) >= thirtyDaysAgo && ['PAID', 'VERIFIED'].includes(payment.status))
		.reduce((sum: number, payment: any) => sum + (payment.amountCents || 0), 0);

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
			recentDossiers: recentDossiers.map((d: any) => ({
				id: d.id,
				numero: d.numero,
				status: d.status,
				typeOuverture: d.typeOuverture,
				montantInitial: d.montantInitial,
				client: `${d.client?.prenom || ''} ${d.client?.nom || ''}`.trim(),
				updatedAt: d.updatedAt,
			})),
			subscriptions: subscriptions.slice(0, 8).map((subscription: any) => ({
				id: subscription.id,
				companyName: subscription.companyName,
				plan: subscription.plan,
				billingCycle: subscription.billingCycle,
				status: subscription.status,
				priceCents: subscription.priceCents,
				currency: subscription.currency,
				seats: subscription.seats,
				currentPeriodEnd: subscription.currentPeriodEnd,
				owner: subscription.owner,
			})),
			recentPayments: payments.slice(0, 8).map((payment: any) => ({
				id: payment.id,
				reference: payment.reference,
				amountCents: payment.amountCents,
				currency: payment.currency,
				status: payment.status,
				method: payment.method,
				description: payment.description,
				paidAt: payment.paidAt,
				subscription: payment.subscription,
				user: payment.user,
			})),
			activationKeys: activationKeys.slice(0, 8).map((key: any) => ({
				id: key.id,
				code: key.code,
				label: key.label,
				plan: key.plan,
				billingCycle: key.billingCycle,
				priceCents: key.priceCents,
				currency: key.currency,
				status: key.status,
				isRedeemed: key.isRedeemed,
				redeemedAt: key.redeemedAt,
				redeemedByUser: key.redeemedByUser,
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

	const payment = await (prisma as any).payment.update({
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
		throw new ValidationError('Statut d’abonnement invalide');
	}

	const subscription = await (prisma as any).subscription.update({
		where: { id },
		data: {
			status: nextStatus,
			cancelledAt: nextStatus === 'CANCELLED' ? new Date() : null,
		},
	});

	res.json({
		success: true,
		message: 'Statut de l’abonnement mis à jour',
		data: { subscription }
	});
}));

export default router;
