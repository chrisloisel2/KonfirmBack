/**
 * Intelligence Routes — /api/intelligence
 *
 *  POST /api/intelligence/report           Générer un rapport d'intelligence
 *  GET  /api/intelligence/reports          Lister les rapports de l'utilisateur
 *  GET  /api/intelligence/reports/:id      Récupérer un rapport
 *  DELETE /api/intelligence/reports/:id    Supprimer un rapport
 *  POST /api/intelligence/osint            Recherche OSINT rapide (sans rapport)
 *  POST /api/intelligence/fuzzy            Test de correspondance fuzzy
 *  GET  /api/intelligence/timeline         Timeline d'un client/dossier
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ValidationError } from '../../middleware/errorHandler';
import { authenticateToken, AuthenticatedRequest } from '../../middleware/auth';
import {
	generateIntelligenceReport,
	getUserReports,
	getReport,
	type IntelligenceReportInput,
} from '../../services/intelligenceService';
import {
	runOsintMega,
	runOsintQuick,
	type OsintQuery,
} from '../../services/osintMegaService';
import {
	computeFuzzyMatch,
	matchFullName,
	screenNameAgainstList,
} from '../../services/fuzzyMatchService';
import {
	getEntityTimeline,
} from '../../services/universalSearchService';
import prisma from '../../lib/prisma';

const router = Router();
const auth = authenticateToken as any;

// ─── Schemas ────────────────────────────────────────────────────────────────

const reportInputSchema = z.object({
	nom:           z.string().min(1),
	prenom:        z.string().optional(),
	dateNaissance: z.string().optional(),
	nationalite:   z.string().optional(),
	pays:          z.string().optional(),
	entreprise:    z.string().optional(),
	siret:         z.string().optional(),
	subjectType:   z.enum(['PERSON', 'COMPANY', 'MIXED']).default('PERSON'),
	clientId:      z.string().optional(),
	dossierId:     z.string().optional(),
});

const osintSchema = z.object({
	nom:                 z.string().min(1),
	prenom:              z.string().optional(),
	dateNaissance:       z.string().optional(),
	nationalite:         z.string().optional(),
	pays:                z.string().optional(),
	entreprise:          z.string().optional(),
	siret:               z.string().optional(),
	type:                z.enum(['PERSON', 'COMPANY', 'MIXED']).default('PERSON'),
	confidenceThreshold: z.number().min(0).max(1).default(0.72),
	mode:                z.enum(['full', 'quick']).default('quick'),
});

const fuzzySchema = z.object({
	query:     z.string().min(1),
	candidate: z.string().min(1).optional(),
	list:      z.array(z.string()).optional(),
	queryFirst: z.string().optional(),
	queryLast:  z.string().optional(),
	candidateFirst: z.string().optional(),
	candidateLast:  z.string().optional(),
	threshold:  z.number().min(0).max(1).default(0.72),
});

const timelineSchema = z.object({
	clientId:  z.string().optional(),
	dossierId: z.string().optional(),
	userId:    z.string().optional(),
	dateFrom:  z.string().optional(),
	dateTo:    z.string().optional(),
	types:     z.array(z.string()).optional(),
	limit:     z.coerce.number().min(1).max(500).default(200),
});

// ─── POST /api/intelligence/report ───────────────────────────────────────────

router.post('/report', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const data = reportInputSchema.parse(req.body);

	// Check if recent report exists (within 24h) to avoid duplicate work
	const recentReport = await (prisma as any).intelligenceReport.findFirst({
		where: {
			userId: req.user!.id,
			subjectName: data.prenom ? `${data.prenom} ${data.nom}` : data.nom,
			createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
		},
		orderBy: { createdAt: 'desc' }
	});

	if (recentReport && !req.query.force) {
		return res.json({
			success: true,
			data: { report: recentReport, cached: true, message: 'Rapport récent trouvé (< 24h). Ajoutez ?force=1 pour régénérer.' }
		});
	}

	const input: IntelligenceReportInput = {
		...data,
		requestedBy: req.user!.id,
	};

	const report = await generateIntelligenceReport(input);
	res.json({ success: true, data: { report } });
}));

// ─── GET /api/intelligence/reports ───────────────────────────────────────────

router.get('/reports', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const reports = await getUserReports(req.user!.id);
	res.json({ success: true, data: { reports } });
}));

// ─── GET /api/intelligence/reports/:id ───────────────────────────────────────

router.get('/reports/:id', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const report = await getReport(req.params.id, req.user!.id);
	if (!report) throw new ValidationError('Rapport introuvable');
	res.json({ success: true, data: { report } });
}));

// ─── DELETE /api/intelligence/reports/:id ────────────────────────────────────

router.delete('/reports/:id', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	await (prisma as any).intelligenceReport.deleteMany({
		where: { id: req.params.id, userId: req.user!.id }
	});
	res.json({ success: true });
}));

// ─── POST /api/intelligence/osint — Quick OSINT ───────────────────────────────

router.post('/osint', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const data = osintSchema.parse(req.body);

	const query: OsintQuery = {
		nom:                 data.nom,
		prenom:              data.prenom,
		dateNaissance:       data.dateNaissance,
		nationalite:         data.nationalite,
		pays:                data.pays,
		entreprise:          data.entreprise,
		siret:               data.siret,
		type:                data.type,
		confidenceThreshold: data.confidenceThreshold,
	};

	const report = data.mode === 'full'
		? await runOsintMega(query)
		: await runOsintQuick(query);

	res.json({ success: true, data: { report } });
}));

// ─── POST /api/intelligence/fuzzy — Fuzzy name matching ──────────────────────

router.post('/fuzzy', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const data = fuzzySchema.parse(req.body);

	if (data.candidate) {
		// Single pair comparison
		const result = computeFuzzyMatch(data.query, data.candidate, data.threshold);
		return res.json({ success: true, data: { result } });
	}

	if (data.queryFirst && data.queryLast && data.candidateFirst && data.candidateLast) {
		// Full name comparison
		const result = matchFullName(
			data.queryFirst, data.queryLast,
			data.candidateFirst, data.candidateLast,
			data.threshold
		);
		return res.json({ success: true, data: { result } });
	}

	if (data.list && data.list.length > 0) {
		// Screen against list
		const results = screenNameAgainstList(data.query, data.list, data.threshold);
		return res.json({ success: true, data: { results, matchCount: results.length } });
	}

	throw new ValidationError('Fournir: candidate, ou queryFirst+queryLast+candidateFirst+candidateLast, ou list');
}));

// ─── GET /api/intelligence/timeline ──────────────────────────────────────────

router.get('/timeline', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const params = timelineSchema.parse(req.query);

	if (!params.clientId && !params.dossierId && !params.userId) {
		throw new ValidationError('Fournir clientId, dossierId ou userId');
	}

	// Restrict userId timeline to self unless admin/referent
	if (params.userId && params.userId !== req.user!.id) {
		const role = req.user!.role;
		if (!['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(role)) {
			throw new ValidationError('Accès refusé à la timeline d\'un autre utilisateur');
		}
	}

	const events = await getEntityTimeline({
		clientId:  params.clientId,
		dossierId: params.dossierId,
		userId:    params.userId,
		dateFrom:  params.dateFrom,
		dateTo:    params.dateTo,
		types:     params.types,
		limit:     params.limit,
	});

	res.json({
		success: true,
		data: {
			events,
			total: events.length,
			dateRange: {
				from: events.length > 0 ? events[events.length - 1].timestamp : null,
				to:   events.length > 0 ? events[0].timestamp : null,
			}
		}
	});
}));

// ─── POST /api/intelligence/timeline — Timeline for a client by name ─────────

router.post('/timeline', auth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
	const { nom, prenom, dateFrom, dateTo, limit } = z.object({
		nom:      z.string().min(1),
		prenom:   z.string().optional(),
		dateFrom: z.string().optional(),
		dateTo:   z.string().optional(),
		limit:    z.number().default(200),
	}).parse(req.body);

	// Find client by name
	const client = await (prisma as any).client.findFirst({
		where: {
			nom:    { contains: nom, mode: 'insensitive' },
			...(prenom ? { prenom: { contains: prenom, mode: 'insensitive' } } : {}),
		}
	});

	if (!client) {
		return res.json({
			success: true,
			data: { events: [], total: 0, message: 'Client non trouvé en base interne' }
		});
	}

	const events = await getEntityTimeline({
		clientId: client.id,
		dateFrom,
		dateTo,
		limit,
	});

	res.json({
		success: true,
		data: {
			client: { id: client.id, nom: client.nom, prenom: client.prenom },
			events,
			total: events.length,
		}
	});
}));

export default router;
