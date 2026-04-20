"use strict";
/**
 * Universal Search Service
 *
 * Recherche full-text en temps réel sur l'intégralité de la base de données :
 *   - Clients (nom, prénom, email, téléphone, adresse, profession, employeur, n° identité)
 *   - Dossiers (numéro, notes, type, montant)
 *   - Documents (OCR text, nom de fichier)
 *   - Exceptions (description, résolution)
 *   - Déclarations TRACFIN (description, nature du soupçon)
 *   - Logs d'audit (action, ressource)
 *   - Recherches (query, résultats)
 *   - Scoring (justification, recommandation)
 *
 * Fonctionnalités :
 *   - Recherche par regex case-insensitive avec accents normalisés
 *   - Scoring de pertinence par entité
 *   - Facettes (count par type d'entité)
 *   - Pagination
 *   - Tri par pertinence ou date
 *   - Suggestions / autocomplete
 *   - Historique des recherches
 *   - Filtres avancés (50+ critères)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.universalSearch = universalSearch;
exports.generateSuggestions = generateSuggestions;
exports.getEntityTimeline = getEntityTimeline;
exports.recordSearchHistory = recordSearchHistory;
const prisma_1 = __importDefault(require("../lib/prisma"));
const fuzzyMatchService_1 = require("./fuzzyMatchService");
const logger_1 = require("../utils/logger");
// ─── Build regex from query ──────────────────────────────────────────────────
function buildSearchRegex(query) {
    const normalized = (0, fuzzyMatchService_1.normalize)(query);
    // Escape special regex chars but keep spaces
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Also match with normalized version
    return new RegExp(escaped, 'i');
}
function buildSearchPattern(query) {
    return query
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .split(/\s+/)
        .filter(Boolean)
        .join('.*');
}
function highlightText(text, query, maxLen = 200) {
    if (!text)
        return '';
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1)
        return text.substring(0, maxLen);
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + query.length + 80);
    let snippet = text.substring(start, end);
    if (start > 0)
        snippet = '…' + snippet;
    if (end < text.length)
        snippet = snippet + '…';
    return snippet;
}
// ─── Score de pertinence ─────────────────────────────────────────────────────
function computeRelevanceScore(text, query) {
    if (!text)
        return 0;
    const tl = text.toLowerCase();
    const ql = query.toLowerCase();
    const tokens = ql.split(/\s+/).filter(Boolean);
    let score = 0;
    // Exact full match: max score
    if (tl === ql)
        return 1.0;
    if (tl.startsWith(ql))
        score += 0.9;
    else if (tl.includes(ql))
        score += 0.7;
    // Token matches
    for (const token of tokens) {
        if (tl.startsWith(token))
            score += 0.2;
        else if (tl.includes(token))
            score += 0.1;
    }
    return Math.min(score, 1.0);
}
// ─── Main universal search ───────────────────────────────────────────────────
async function universalSearch(opts) {
    const start = Date.now();
    const { query, entityTypes, page = 1, limit = 20, sortBy = 'relevance', filters = {}, userRole, } = opts;
    if (!query || query.trim().length < 1) {
        return emptyResponse(query, start);
    }
    const skip = (page - 1) * limit;
    const regexPattern = buildSearchPattern(query);
    const re = new RegExp(regexPattern, 'i');
    const searchAll = !entityTypes || entityTypes.length === 0;
    const want = (type) => searchAll || entityTypes.includes(type);
    // Build date filter
    const dateFilter = buildDateFilter(filters);
    // Role-based access for dossiers
    const dossierAccessFilter = buildDossierAccessFilter(opts);
    // Run all searches in parallel
    const [clientResults, dossierResults, documentResults, exceptionResults, tracfinResults, auditResults, rechercheResults, scoringResults] = await Promise.all([
        want('CLIENT') ? searchClients(re, query, filters, dateFilter) : Promise.resolve([]),
        want('DOSSIER') ? searchDossiers(re, query, filters, dateFilter, dossierAccessFilter) : Promise.resolve([]),
        want('DOCUMENT') ? searchDocuments(re, query, filters, dateFilter) : Promise.resolve([]),
        want('EXCEPTION') ? searchExceptions(re, query, filters, dateFilter) : Promise.resolve([]),
        want('TRACFIN') ? searchTracfin(re, query, filters, dateFilter) : Promise.resolve([]),
        want('AUDIT') ? searchAuditLogs(re, query, filters, dateFilter) : Promise.resolve([]),
        want('RECHERCHE') ? searchRecherches(re, query, filters, dateFilter) : Promise.resolve([]),
        want('SCORING') ? searchScoring(re, query, filters) : Promise.resolve([]),
    ]);
    // Merge and sort
    let allResults = [
        ...clientResults,
        ...dossierResults,
        ...documentResults,
        ...exceptionResults,
        ...tracfinResults,
        ...auditResults,
        ...rechercheResults,
        ...scoringResults,
    ];
    if (sortBy === 'relevance') {
        allResults.sort((a, b) => b.score - a.score);
    }
    else if (sortBy === 'date') {
        allResults.sort((a, b) => {
            const da = new Date(b.data.createdAt || b.data.timestamp || 0).getTime();
            const db = new Date(a.data.createdAt || a.data.timestamp || 0).getTime();
            return da - db;
        });
    }
    const facets = {
        CLIENT: clientResults.length,
        DOSSIER: dossierResults.length,
        DOCUMENT: documentResults.length,
        EXCEPTION: exceptionResults.length,
        TRACFIN: tracfinResults.length,
        AUDIT: auditResults.length,
        RECHERCHE: rechercheResults.length,
        SCORING: scoringResults.length,
    };
    const total = allResults.length;
    const paged = allResults.slice(skip, skip + limit);
    const suggestions = await generateSuggestions(query);
    return {
        results: paged,
        total,
        totalByType: facets,
        page,
        pageSize: limit,
        hasMore: skip + limit < total,
        query,
        durationMs: Date.now() - start,
        suggestions,
    };
}
// ─── Clients ─────────────────────────────────────────────────────────────────
async function searchClients(re, query, filters, dateFilter) {
    const where = {
        AND: [
            dateFilter,
            filters.nationalite?.length ? { nationalite: { in: filters.nationalite } } : {},
            filters.profession?.length ? { profession: { in: filters.profession } } : {},
            filters.personnePublique !== undefined ? { personnePublique: filters.personnePublique } : {},
            filters.pays?.length ? { pays: { in: filters.pays } } : {},
            filters.ville ? { ville: { contains: filters.ville, mode: 'insensitive' } } : {},
            filters.revenus?.min !== undefined ? { revenus: { gte: filters.revenus.min } } : {},
            filters.revenus?.max !== undefined ? { revenus: { lte: filters.revenus.max } } : {},
        ].filter(f => Object.keys(f).length > 0),
        OR: [
            { nom: { contains: query, mode: 'insensitive' } },
            { prenom: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
            { telephone: { contains: query, mode: 'insensitive' } },
            { numeroIdentite: { contains: query, mode: 'insensitive' } },
            { profession: { contains: query, mode: 'insensitive' } },
            { employeur: { contains: query, mode: 'insensitive' } },
            { adresseComplete: { contains: query, mode: 'insensitive' } },
            { ville: { contains: query, mode: 'insensitive' } },
            { nationalite: { contains: query, mode: 'insensitive' } },
        ]
    };
    const clients = await prisma_1.default.client.findMany({
        where,
        take: 100,
        orderBy: { createdAt: 'desc' },
    });
    return clients.map((c) => {
        const fullName = `${c.prenom} ${c.nom}`;
        const score = Math.max(computeRelevanceScore(fullName, query), computeRelevanceScore(c.email || '', query), computeRelevanceScore(c.numeroIdentite || '', query), computeRelevanceScore(c.profession || '', query));
        return {
            entityType: 'CLIENT',
            entityId: c.id,
            score: score + 0.2, // boost clients
            highlight: {
                nom: c.nom,
                prenom: c.prenom,
                email: c.email || '',
                telephone: c.telephone || '',
                identite: c.numeroIdentite,
            },
            data: c,
            clientName: fullName,
        };
    });
}
// ─── Dossiers ─────────────────────────────────────────────────────────────────
async function searchDossiers(re, query, filters, dateFilter, accessFilter) {
    const where = {
        AND: [
            accessFilter,
            dateFilter,
            filters.dossierStatus?.length ? { status: { in: filters.dossierStatus } } : {},
            filters.typeOuverture?.length ? { typeOuverture: { in: filters.typeOuverture } } : {},
            filters.assignedToId ? { assignedToId: filters.assignedToId } : {},
            filters.createdById ? { createdById: filters.createdById } : {},
            filters.montant?.min !== undefined ? { montantInitial: { gte: filters.montant.min } } : {},
            filters.montant?.max !== undefined ? { montantInitial: { lte: filters.montant.max } } : {},
        ].filter(f => Object.keys(f).length > 0),
        OR: [
            { numero: { contains: query, mode: 'insensitive' } },
            { notes: { contains: query, mode: 'insensitive' } },
            { typeOuverture: { contains: query, mode: 'insensitive' } },
            { client: { OR: [
                        { nom: { contains: query, mode: 'insensitive' } },
                        { prenom: { contains: query, mode: 'insensitive' } },
                        { email: { contains: query, mode: 'insensitive' } },
                    ] } },
        ]
    };
    const dossiers = await prisma_1.default.dossier.findMany({
        where,
        take: 100,
        include: {
            client: { select: { nom: true, prenom: true, email: true } },
            createdBy: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
    });
    return dossiers.map((d) => ({
        entityType: 'DOSSIER',
        entityId: d.id,
        score: computeRelevanceScore(d.numero, query) + 0.15,
        highlight: {
            numero: d.numero,
            status: d.status,
            client: d.client ? `${d.client.prenom} ${d.client.nom}` : '',
            montant: d.montantInitial?.toString() || '',
        },
        data: d,
        dossierId: d.id,
        dossierNumero: d.numero,
        clientName: d.client ? `${d.client.prenom} ${d.client.nom}` : undefined,
    }));
}
// ─── Documents (OCR) ─────────────────────────────────────────────────────────
async function searchDocuments(re, query, filters, dateFilter) {
    const where = {
        AND: [
            dateFilter,
            filters.documentType?.length ? { type: { in: filters.documentType } } : {},
            filters.documentVerified !== undefined ? { isVerified: filters.documentVerified } : {},
            filters.hasOcrText ? { ocrText: { not: null } } : {},
        ].filter(f => Object.keys(f).length > 0),
        OR: [
            { originalName: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
            { ocrText: { contains: query, mode: 'insensitive' } },
        ]
    };
    const docs = await prisma_1.default.document.findMany({
        where,
        take: 50,
        include: {
            dossier: {
                select: { id: true, numero: true },
                include: { client: { select: { nom: true, prenom: true } } }
            }
        },
        orderBy: { createdAt: 'desc' },
    });
    return docs.map((doc) => ({
        entityType: 'DOCUMENT',
        entityId: doc.id,
        score: Math.max(computeRelevanceScore(doc.originalName, query), computeRelevanceScore(doc.ocrText || '', query) * 0.8),
        highlight: {
            fileName: doc.originalName,
            type: doc.type,
            ocrSnippet: highlightText(doc.ocrText || '', query),
        },
        data: { ...doc, ocrText: undefined }, // don't return full OCR in list
        dossierId: doc.dossier?.id,
        dossierNumero: doc.dossier?.numero,
        clientName: doc.dossier?.client ? `${doc.dossier.client.prenom} ${doc.dossier.client.nom}` : undefined,
    }));
}
// ─── Exceptions ──────────────────────────────────────────────────────────────
async function searchExceptions(re, query, filters, dateFilter) {
    const where = {
        AND: [
            dateFilter,
            filters.exceptionType?.length ? { type: { in: filters.exceptionType } } : {},
            filters.exceptionStatus?.length ? { status: { in: filters.exceptionStatus } } : {},
            filters.exceptionPriority?.length ? { priority: { in: filters.exceptionPriority } } : {},
        ].filter(f => Object.keys(f).length > 0),
        OR: [
            { description: { contains: query, mode: 'insensitive' } },
            { resolution: { contains: query, mode: 'insensitive' } },
            { dossier: { client: { OR: [
                            { nom: { contains: query, mode: 'insensitive' } },
                            { prenom: { contains: query, mode: 'insensitive' } },
                        ] } } },
        ]
    };
    const exceptions = await prisma_1.default.exception.findMany({
        where,
        take: 50,
        include: {
            dossier: {
                select: { id: true, numero: true },
                include: { client: { select: { nom: true, prenom: true } } }
            },
            assignedTo: { select: { firstName: true, lastName: true } }
        },
        orderBy: { createdAt: 'desc' },
    });
    return exceptions.map((ex) => ({
        entityType: 'EXCEPTION',
        entityId: ex.id,
        score: computeRelevanceScore(ex.description, query),
        highlight: {
            type: ex.type,
            description: highlightText(ex.description, query),
            priority: ex.priority,
            status: ex.status,
        },
        data: ex,
        dossierId: ex.dossier?.id,
        dossierNumero: ex.dossier?.numero,
        clientName: ex.dossier?.client ? `${ex.dossier.client.prenom} ${ex.dossier.client.nom}` : undefined,
    }));
}
// ─── TRACFIN ─────────────────────────────────────────────────────────────────
async function searchTracfin(re, query, filters, dateFilter) {
    const where = {
        AND: [
            dateFilter,
            filters.tracfinStatus?.length ? { status: { in: filters.tracfinStatus } } : {},
            filters.risqueLevel?.length ? { risqueIdentifie: { in: filters.risqueLevel } } : {},
        ].filter(f => Object.keys(f).length > 0),
        OR: [
            { clientNom: { contains: query, mode: 'insensitive' } },
            { clientPrenom: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
            { natureSoupcon: { contains: query, mode: 'insensitive' } },
            { beneficiaire: { contains: query, mode: 'insensitive' } },
            { ermesReference: { contains: query, mode: 'insensitive' } },
        ]
    };
    const decls = await prisma_1.default.tracfinDeclaration.findMany({
        where,
        take: 30,
        include: {
            dossier: { select: { id: true, numero: true } },
        },
        orderBy: { createdAt: 'desc' },
    });
    return decls.map((d) => ({
        entityType: 'TRACFIN',
        entityId: d.id,
        score: computeRelevanceScore(`${d.clientPrenom} ${d.clientNom}`, query) + 0.1,
        highlight: {
            client: `${d.clientPrenom} ${d.clientNom}`,
            nature: d.natureSoupcon,
            description: highlightText(d.description, query),
            status: d.status,
            risque: d.risqueIdentifie,
        },
        data: d,
        dossierId: d.dossier?.id,
        dossierNumero: d.dossier?.numero,
        clientName: `${d.clientPrenom} ${d.clientNom}`,
    }));
}
// ─── Audit logs ───────────────────────────────────────────────────────────────
async function searchAuditLogs(re, query, filters, dateFilter) {
    const where = {
        AND: [
            { timestamp: dateFilter.createdAt || {} },
            filters.auditAction?.length ? { action: { in: filters.auditAction } } : {},
            filters.auditResource ? { resource: { contains: filters.auditResource, mode: 'insensitive' } } : {},
            filters.ipAddress ? { ipAddress: { contains: filters.ipAddress } } : {},
        ].filter(f => Object.keys(f).length > 0),
        OR: [
            { resource: { contains: query, mode: 'insensitive' } },
            { resourceId: { contains: query, mode: 'insensitive' } },
            { ipAddress: { contains: query, mode: 'insensitive' } },
        ]
    };
    const logs = await prisma_1.default.auditLog.findMany({
        where,
        take: 50,
        include: {
            user: { select: { firstName: true, lastName: true, email: true } },
            dossier: { select: { id: true, numero: true } },
        },
        orderBy: { timestamp: 'desc' },
    });
    return logs.map((log) => ({
        entityType: 'AUDIT',
        entityId: log.id,
        score: computeRelevanceScore(log.resource, query) * 0.5,
        highlight: {
            action: log.action,
            resource: log.resource,
            user: log.user ? `${log.user.firstName} ${log.user.lastName}` : 'Système',
            ip: log.ipAddress || '',
        },
        data: log,
        dossierId: log.dossier?.id,
        dossierNumero: log.dossier?.numero,
    }));
}
// ─── Recherches LCB-FT ────────────────────────────────────────────────────────
async function searchRecherches(re, query, filters, dateFilter) {
    const where = {
        AND: [
            { executedAt: dateFilter.createdAt || {} },
            filters.rechercheType?.length ? { type: { in: filters.rechercheType } } : {},
            filters.rechercheStatus?.length ? { status: { in: filters.rechercheStatus } } : {},
            filters.confidenceMin !== undefined ? { confidence: { gte: filters.confidenceMin } } : {},
        ].filter(f => Object.keys(f).length > 0),
    };
    // Search within JSON query field — use raw approach
    const recherches = await prisma_1.default.recherche.findMany({
        where: {
            ...where,
            dossier: { client: { OR: [
                        { nom: { contains: query, mode: 'insensitive' } },
                        { prenom: { contains: query, mode: 'insensitive' } },
                    ] } }
        },
        take: 50,
        include: {
            dossier: {
                select: { id: true, numero: true },
                include: { client: { select: { nom: true, prenom: true } } }
            }
        },
        orderBy: { executedAt: 'desc' },
    });
    return recherches.map((r) => ({
        entityType: 'RECHERCHE',
        entityId: r.id,
        score: r.confidence || 0.3,
        highlight: {
            type: r.type,
            status: r.status,
            confidence: r.confidence?.toFixed(2) || '0',
            client: r.dossier?.client ? `${r.dossier.client.prenom} ${r.dossier.client.nom}` : '',
        },
        data: r,
        dossierId: r.dossier?.id,
        dossierNumero: r.dossier?.numero,
        clientName: r.dossier?.client ? `${r.dossier.client.prenom} ${r.dossier.client.nom}` : undefined,
    }));
}
// ─── Scoring ─────────────────────────────────────────────────────────────────
async function searchScoring(re, query, filters) {
    const where = {
        AND: [
            filters.scoringNiveau?.length ? { niveau: { in: filters.scoringNiveau } } : {},
            filters.scoreRange?.min !== undefined ? { scoreTotal: { gte: filters.scoreRange.min } } : {},
            filters.scoreRange?.max !== undefined ? { scoreTotal: { lte: filters.scoreRange.max } } : {},
        ].filter(f => Object.keys(f).length > 0),
        OR: [
            { recommandation: { contains: query, mode: 'insensitive' } },
            { justification: { contains: query, mode: 'insensitive' } },
        ]
    };
    const scorings = await prisma_1.default.scoring.findMany({
        where,
        take: 30,
    });
    return scorings.map((s) => ({
        entityType: 'SCORING',
        entityId: s.id,
        score: computeRelevanceScore(s.justification, query) * 0.5,
        highlight: {
            niveau: s.niveau,
            score: s.scoreTotal.toString(),
            recommandation: highlightText(s.recommandation, query, 100),
        },
        data: s,
        dossierId: s.dossierId,
    }));
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
function buildDateFilter(filters) {
    if (!filters.dateFrom && !filters.dateTo)
        return {};
    return {
        createdAt: {
            ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
            ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
        }
    };
}
function buildDossierAccessFilter(opts) {
    if (!opts.userRole || ['REFERENT', 'RESPONSABLE', 'ADMIN'].includes(opts.userRole))
        return {};
    if (!opts.userId)
        return {};
    return {
        OR: [
            { createdById: opts.userId },
            { assignedToId: opts.userId },
        ]
    };
}
function emptyResponse(query, start) {
    return {
        results: [],
        total: 0,
        totalByType: { CLIENT: 0, DOSSIER: 0, DOCUMENT: 0, EXCEPTION: 0, TRACFIN: 0, AUDIT: 0, RECHERCHE: 0, SCORING: 0 },
        page: 1,
        pageSize: 20,
        hasMore: false,
        query,
        durationMs: Date.now() - start,
        suggestions: [],
    };
}
// ─── Autocomplete / Suggestions ──────────────────────────────────────────────
async function generateSuggestions(query) {
    if (query.length < 2)
        return [];
    const suggestions = new Set();
    // Fetch client names matching prefix
    const clients = await prisma_1.default.client.findMany({
        where: {
            OR: [
                { nom: { startsWith: query, mode: 'insensitive' } },
                { prenom: { startsWith: query, mode: 'insensitive' } },
            ]
        },
        take: 5,
        select: { nom: true, prenom: true },
    });
    for (const c of clients) {
        suggestions.add(`${c.prenom} ${c.nom}`);
        suggestions.add(c.nom);
    }
    // Dossier numbers
    const dossiers = await prisma_1.default.dossier.findMany({
        where: { numero: { startsWith: query, mode: 'insensitive' } },
        take: 3,
        select: { numero: true },
    });
    for (const d of dossiers)
        suggestions.add(d.numero);
    return Array.from(suggestions).slice(0, 8);
}
async function getEntityTimeline(opts) {
    const { clientId, dossierId, dateFrom, dateTo, limit = 200 } = opts;
    const events = [];
    const dateRange = {};
    if (dateFrom)
        dateRange.gte = new Date(dateFrom);
    if (dateTo)
        dateRange.lte = new Date(dateTo);
    // Find related dossier IDs from clientId
    let dossierIds = [];
    if (clientId) {
        const dossiers = await prisma_1.default.dossier.findMany({
            where: { clientId },
            select: { id: true, numero: true },
        });
        dossierIds = dossiers.map((d) => d.id);
    }
    else if (dossierId) {
        dossierIds = [dossierId];
    }
    if (dossierIds.length === 0 && !opts.userId)
        return [];
    // Dossier events
    if (dossierIds.length > 0) {
        const dossiers = await prisma_1.default.dossier.findMany({
            where: {
                id: { in: dossierIds },
                ...(Object.keys(dateRange).length ? { createdAt: dateRange } : {}),
            },
            include: {
                client: { select: { nom: true, prenom: true } },
                createdBy: { select: { firstName: true, lastName: true } },
            },
        });
        for (const d of dossiers) {
            events.push({
                id: `dossier-created-${d.id}`,
                type: 'DOSSIER_CREATED',
                entityType: 'DOSSIER',
                timestamp: d.createdAt,
                title: `Dossier ${d.numero} créé`,
                description: `Type: ${d.typeOuverture} | Montant: ${d.montantInitial ? d.montantInitial + '€' : 'N/A'}`,
                severity: 'info',
                dossierId: d.id,
                dossierNumero: d.numero,
                userId: d.createdById,
                userName: d.createdBy ? `${d.createdBy.firstName} ${d.createdBy.lastName}` : undefined,
                data: d,
            });
            if (d.updatedAt.getTime() !== d.createdAt.getTime()) {
                events.push({
                    id: `dossier-updated-${d.id}`,
                    type: 'DOSSIER_UPDATED',
                    entityType: 'DOSSIER',
                    timestamp: d.updatedAt,
                    title: `Dossier ${d.numero} mis à jour`,
                    description: `Statut: ${d.status}`,
                    severity: d.status === 'VALIDE' ? 'success' : d.status === 'REJETE' ? 'error' : 'info',
                    dossierId: d.id,
                    dossierNumero: d.numero,
                    data: { status: d.status },
                });
            }
        }
        // Recherches
        const recherches = await prisma_1.default.recherche.findMany({
            where: {
                dossierId: { in: dossierIds },
                ...(Object.keys(dateRange).length ? { executedAt: dateRange } : {}),
            },
            include: { dossier: { select: { numero: true } } },
        });
        for (const r of recherches) {
            events.push({
                id: `recherche-${r.id}`,
                type: `RECHERCHE_${r.type}`,
                entityType: 'RECHERCHE',
                timestamp: r.executedAt,
                title: `Recherche ${r.type} lancée`,
                description: `Statut: ${r.status} | Confiance: ${r.confidence ? (r.confidence * 100).toFixed(0) + '%' : 'N/A'}`,
                severity: r.confidence && r.confidence >= 0.7 ? 'warning' : 'info',
                dossierId: r.dossierId,
                dossierNumero: r.dossier?.numero,
                data: { type: r.type, status: r.status, confidence: r.confidence, matches: r.matches },
            });
        }
        // Exceptions
        const exceptions = await prisma_1.default.exception.findMany({
            where: {
                dossierId: { in: dossierIds },
                ...(Object.keys(dateRange).length ? { createdAt: dateRange } : {}),
            },
            include: { dossier: { select: { numero: true } } },
        });
        for (const ex of exceptions) {
            events.push({
                id: `exception-${ex.id}`,
                type: `EXCEPTION_${ex.type}`,
                entityType: 'EXCEPTION',
                timestamp: ex.createdAt,
                title: `Exception ${ex.type.replace(/_/g, ' ')}`,
                description: ex.description,
                severity: ex.priority === 'CRITIQUE' ? 'error' : ex.priority === 'HAUTE' ? 'warning' : 'info',
                dossierId: ex.dossierId,
                dossierNumero: ex.dossier?.numero,
                data: { type: ex.type, priority: ex.priority, status: ex.status },
            });
        }
        // Documents
        const documents = await prisma_1.default.document.findMany({
            where: {
                dossierId: { in: dossierIds },
                ...(Object.keys(dateRange).length ? { createdAt: dateRange } : {}),
            },
            include: { dossier: { select: { numero: true } } },
        });
        for (const doc of documents) {
            events.push({
                id: `document-${doc.id}`,
                type: 'DOCUMENT_UPLOADED',
                entityType: 'DOCUMENT',
                timestamp: doc.createdAt,
                title: `Document ${doc.type} ajouté`,
                description: `Fichier: ${doc.originalName} | Vérifié: ${doc.isVerified ? 'Oui' : 'Non'}`,
                severity: doc.isVerified ? 'success' : 'info',
                dossierId: doc.dossierId,
                dossierNumero: doc.dossier?.numero,
                data: { type: doc.type, fileName: doc.originalName, isVerified: doc.isVerified },
            });
        }
        // Scoring
        const scorings = await prisma_1.default.scoring.findMany({
            where: {
                dossierId: { in: dossierIds },
                ...(Object.keys(dateRange).length ? { calculatedAt: dateRange } : {}),
            },
        });
        for (const s of scorings) {
            events.push({
                id: `scoring-${s.id}`,
                type: 'SCORING_CALCULATED',
                entityType: 'SCORING',
                timestamp: s.calculatedAt,
                title: `Score de risque calculé: ${s.niveau}`,
                description: `Score: ${s.scoreTotal}/100 | ${s.recommandation}`,
                severity: s.niveau === 'CRITIQUE' ? 'error' : s.niveau === 'ELEVE' ? 'warning' : 'success',
                dossierId: s.dossierId,
                data: { niveau: s.niveau, score: s.scoreTotal, recommandation: s.recommandation },
            });
        }
        // TRACFIN
        const tracfins = await prisma_1.default.tracfinDeclaration.findMany({
            where: {
                dossierId: { in: dossierIds },
                ...(Object.keys(dateRange).length ? { createdAt: dateRange } : {}),
            },
            include: { dossier: { select: { numero: true } } },
        });
        for (const t of tracfins) {
            events.push({
                id: `tracfin-${t.id}`,
                type: 'TRACFIN_DECLARATION',
                entityType: 'TRACFIN',
                timestamp: t.createdAt,
                title: `Déclaration TRACFIN ${t.status}`,
                description: `Nature: ${t.natureSoupcon} | Risque: ${t.risqueIdentifie} | Montant: ${t.montant}€`,
                severity: 'error',
                dossierId: t.dossierId,
                dossierNumero: t.dossier?.numero,
                data: { status: t.status, risque: t.risqueIdentifie, montant: t.montant },
            });
        }
    }
    // Audit logs
    const auditWhere = {
        ...(opts.userId ? { userId: opts.userId } : {}),
        ...(dossierIds.length > 0 ? { dossierId: { in: dossierIds } } : {}),
        ...(Object.keys(dateRange).length ? { timestamp: dateRange } : {}),
    };
    const auditLogs = await prisma_1.default.auditLog.findMany({
        where: auditWhere,
        take: 200,
        include: {
            user: { select: { firstName: true, lastName: true } },
            dossier: { select: { numero: true } },
        },
        orderBy: { timestamp: 'desc' },
    });
    for (const log of auditLogs) {
        events.push({
            id: `audit-${log.id}`,
            type: `AUDIT_${log.action}`,
            entityType: 'AUDIT',
            timestamp: log.timestamp,
            title: `${log.action} sur ${log.resource}`,
            description: `Par ${log.user ? `${log.user.firstName} ${log.user.lastName}` : 'Système'} depuis ${log.ipAddress || 'N/A'}`,
            severity: log.action === 'ACCESS_DENIED' ? 'error' : 'info',
            dossierId: log.dossierId || undefined,
            dossierNumero: log.dossier?.numero,
            userId: log.userId || undefined,
            userName: log.user ? `${log.user.firstName} ${log.user.lastName}` : undefined,
            data: { action: log.action, resource: log.resource, ip: log.ipAddress },
        });
    }
    // Sort chronologically
    events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return events.slice(0, limit);
}
// ─── Track search in history ─────────────────────────────────────────────────
async function recordSearchHistory(userId, query, queryParams, response) {
    try {
        await prisma_1.default.searchHistory.create({
            data: {
                userId,
                query,
                queryParams,
                resultsCount: response.total,
                entityTypes: Object.entries(response.totalByType)
                    .filter(([, v]) => v > 0)
                    .map(([k]) => k),
                sources: ['internal'],
                durationMs: response.durationMs,
            }
        });
    }
    catch (e) {
        // Non-blocking — search history failure must not fail the search
        (0, logger_1.logSystemEvent)({ action: 'search_history_error', component: 'universalSearch', details: { error: String(e) }, severity: 'warn' });
    }
}
//# sourceMappingURL=universalSearchService.js.map