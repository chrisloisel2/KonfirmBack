"use strict";
/**
 * Company Intelligence Service — Détection de schémas d'évasion fiscale
 *
 * Sources:
 *   1. INSEE Recherche Entreprises (api.gouv.fr) — aucune clé, officiel
 *   2. BODACC (liquidations officielles)           — production seulement
 *   3. Société.com                                 — scraping HTML
 *
 * Patterns détectés:
 *   - Liquidations en série      : personne liée à 2+ entreprises liquidées
 *   - Entreprises "phoenix"      : nouvelle société créée après liquidation, même secteur
 *   - Réseau de sociétés-écrans  : holding + plusieurs filiales à la même adresse
 *   - Micro-entreprises multiples: 3+ EI actives = fractionnement de chiffre d'affaires
 *   - Durée de vie courte        : entreprises ouvertes < 2 ans puis fermées
 *   - Holding pure               : société 64.20Z sans salarié = optimisation agressive
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkCompanyIntelligence = checkCompanyIntelligence;
const axios_1 = __importDefault(require("axios"));
const cheerio = __importStar(require("cheerio"));
const logger_1 = require("../utils/logger");
// ─── Libellés NAF simplifiés ──────────────────────────────────────────────────
const NAF_LABELS = {
    '64.20Z': 'Sociétés holding',
    '64.30Z': 'Fonds / trusts / entités similaires',
    '68.20A': 'Location d\'appartements',
    '68.20B': 'Location de logements',
    '68.10Z': 'Marchands de biens immobiliers',
    '70.10Z': 'Activités des sièges sociaux',
    '70.22Z': 'Conseil en gestion / management',
    '73.11Z': 'Activités des agences de publicité',
    '82.99Z': 'Autres activités de soutien aux entreprises',
    '90.01Z': 'Arts du spectacle vivant',
    '47.91A': 'Vente à distance sur catalogue',
};
function nafLabel(code) {
    return NAF_LABELS[code] ?? code;
}
function legalFormLabel(code) {
    const FORMS = {
        '1000': 'Entrepreneur individuel (EI)',
        '5499': 'SARL',
        '5710': 'SAS',
        '5720': 'SA',
        '5699': 'EURL',
        '6540': 'Société civile (SC)',
        '6552': 'Société civile immobilière (SCI)',
        '6316': 'SCEA',
        '9220': 'Association loi 1901',
    };
    return FORMS[code] ?? `Forme ${code}`;
}
function monthsBetween(d1, d2) {
    if (!d1)
        return undefined;
    const start = new Date(d1).getTime();
    const end = d2 ? new Date(d2).getTime() : Date.now();
    return Math.round((end - start) / (30.44 * 86400000));
}
// ─── 1. INSEE Recherche Entreprises ──────────────────────────────────────────
async function queryINSEE(nom, prenom) {
    const results = [];
    const nomLower = nom.toLowerCase();
    const prenomFirst = prenom.toLowerCase().split(' ')[0]; // premier prénom
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages && page <= 5) {
        try {
            const res = await axios_1.default.get('https://recherche-entreprises.api.gouv.fr/search', {
                params: { q: `${prenom} ${nom}`, page, per_page: 25 },
                timeout: 10000,
                headers: { 'User-Agent': 'KonfirmApp/1.0 (contact@konfirm.fr)' },
            });
            const data = res.data;
            const total = data?.total_results ?? 0;
            totalPages = Math.ceil(total / 25);
            for (const company of (data?.results ?? [])) {
                // Vérifie que notre personne est bien dirigeante (pas juste homonyme)
                const isDirigeant = (company.dirigeants ?? []).some((d) => d.nom?.toLowerCase().includes(nomLower) &&
                    d.prenoms?.toLowerCase().includes(prenomFirst));
                // Ou c'est son EI (nom_complet = NOM PRENOM) — vérifie aussi le prénom pour éviter les homonymes
                const nomComplet = company.nom_complet?.toLowerCase() ?? '';
                const isOwnEI = company.nom_raison_sociale === null &&
                    nomComplet.includes(nomLower) &&
                    nomComplet.includes(prenomFirst);
                if (!isDirigeant && !isOwnEI)
                    continue;
                const role = (company.dirigeants ?? []).find((d) => d.nom?.toLowerCase().includes(nomLower))?.qualite ?? (isOwnEI ? 'Entrepreneur individuel' : 'Dirigeant');
                const created = company.date_creation;
                const closed = company.date_fermeture ?? company.siege?.date_fermeture;
                const isActive = company.etat_administratif === 'A';
                const naf = company.activite_principale ?? '';
                const isHolding = naf === '64.20Z' || naf === '64.30Z' || naf === '70.10Z';
                const isEI = company.nature_juridique === '1000' ||
                    company.complements?.est_entrepreneur_individuel === true;
                results.push({
                    name: company.nom_raison_sociale ?? company.nom_complet ?? 'Inconnu',
                    siren: company.siren,
                    status: isActive ? 'active' : 'closed',
                    role,
                    dateCreation: created,
                    dateFermeture: closed ?? undefined,
                    lifespanMonths: !isActive ? monthsBetween(created, closed) : undefined,
                    activity: naf,
                    activityLabel: nafLabel(naf),
                    address: company.siege?.adresse,
                    city: company.siege?.libelle_commune,
                    legalForm: legalFormLabel(company.nature_juridique ?? ''),
                    isHolding,
                    isSoleTrader: isEI,
                    source: 'INSEE',
                });
            }
            page++;
        }
        catch {
            break;
        }
    }
    return results;
}
// ─── 2. BODACC liquidations (cross-reference par SIREN) ───────────────────────
async function queryBODACCBySiren(siren) {
    try {
        const res = await axios_1.default.get('https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-pcl/records', {
            params: { where: `id_siren = "${siren}"`, limit: 1 },
            timeout: 8000,
            headers: { 'User-Agent': 'KonfirmApp/1.0' },
        });
        const record = res.data?.results?.[0];
        if (!record)
            return null;
        const type = (record.fields?.typeavis_lib ?? record.typeavis_lib ?? '').toLowerCase();
        if (type.includes('liquidation'))
            return 'liquidation';
        if (type.includes('redressement'))
            return 'redressement';
        return null;
    }
    catch {
        return null;
    }
}
// ─── 3. Société.com — scraping dirigeant ─────────────────────────────────────
async function querySocieteCom(nom, prenom) {
    const results = [];
    try {
        const res = await axios_1.default.get(`https://www.societe.com/cgi-bin/search?champs=${encodeURIComponent(`${prenom} ${nom}`)}`, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'fr-FR,fr;q=0.9',
            },
        });
        const $ = cheerio.load(res.data);
        // Société.com résultats de recherche — tenter plusieurs sélecteurs
        $('tr[id^="tr"], div.resultat, div[class*="result"], li[class*="result"]').each((_, el) => {
            const $el = $(el);
            const name = $el.find('a[href*="/societe/"], strong').first().text().trim();
            const href = $el.find('a[href*="/societe/"]').first().attr('href') ?? '';
            const status = $el.find('[class*="statut"], [class*="status"]').first().text().trim().toLowerCase();
            const sirenTxt = href.match(/(\d{9})/)?.[1];
            const isActive = !status.includes('radi') && !status.includes('ferm') && !status.includes('liquid');
            if (name && name.length > 2) {
                results.push({
                    name,
                    siren: sirenTxt,
                    status: status.includes('liquid') ? 'liquidation' : isActive ? 'active' : 'closed',
                    source: 'Société.com',
                    isHolding: false,
                    isSoleTrader: false,
                });
            }
        });
    }
    catch {
        // silencieux
    }
    return results;
}
// ─── 4. Détection de patterns ─────────────────────────────────────────────────
function detectPatterns(companies) {
    const patterns = [];
    if (companies.length === 0)
        return patterns;
    const closed = companies.filter(c => c.status === 'closed' || c.status === 'liquidation');
    const active = companies.filter(c => c.status === 'active');
    const all = companies;
    // ── Pattern 1 : Liquidations en série ────────────────────────────────────
    if (closed.length >= 3) {
        patterns.push({
            type: 'serial_liquidation',
            severity: 'critical',
            label: 'Liquidations en série',
            description: `${closed.length} entreprises fermées/liquidées associées à cette personne — schéma typique d'évitement de dettes ou obligations fiscales.`,
            evidence: closed,
        });
    }
    else if (closed.length >= 2) {
        patterns.push({
            type: 'serial_liquidation',
            severity: 'high',
            label: 'Historique de fermetures',
            description: `${closed.length} entreprises fermées/liquidées — à surveiller.`,
            evidence: closed,
        });
    }
    // ── Pattern 2 : Entreprise "phoenix" ─────────────────────────────────────
    // Même secteur (2 premiers chiffres NAF) : au moins une fermée + une active
    const nafSectors = [...new Set(all.map(c => c.activity?.slice(0, 4)).filter((s) => !!s))];
    for (const sector of nafSectors) {
        const inSector = all.filter(c => c.activity?.startsWith(sector));
        const hasClosed = inSector.some(c => c.status === 'closed' || c.status === 'liquidation');
        const hasActive = inSector.some(c => c.status === 'active');
        if (hasClosed && hasActive && inSector.length >= 2) {
            // Vérifie que la société active a été créée après la fermeture d'une ancienne
            const oldestClosed = inSector
                .filter(c => c.status !== 'active' && c.dateFermeture)
                .sort((a, b) => (a.dateFermeture ?? '').localeCompare(b.dateFermeture ?? ''))
                .at(-1);
            const newestActive = inSector
                .filter(c => c.status === 'active' && c.dateCreation)
                .sort((a, b) => (b.dateCreation ?? '').localeCompare(a.dateCreation ?? ''))
                .at(0);
            const isPhoenix = oldestClosed && newestActive &&
                newestActive.dateCreation >= (oldestClosed.dateFermeture ?? '');
            if (isPhoenix) {
                patterns.push({
                    type: 'phoenix_company',
                    severity: 'critical',
                    label: 'Entreprise "phoenix"',
                    description: `Nouvelle société créée dans le même secteur (${nafLabel(sector + 'Z')}) après la fermeture d'une précédente — schéma classique de contournement de passif.`,
                    evidence: inSector,
                });
            }
        }
    }
    // ── Pattern 3 : Réseau de sociétés-écrans (holding + filiales même adresse) ─
    const addressMap = new Map();
    for (const c of all) {
        if (!c.address)
            continue;
        const key = c.address.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!addressMap.has(key))
            addressMap.set(key, []);
        addressMap.get(key).push(c);
    }
    for (const [addr, group] of addressMap) {
        if (group.length >= 3) {
            const hasHolding = group.some(c => c.isHolding);
            patterns.push({
                type: 'shell_network',
                severity: hasHolding ? 'critical' : 'high',
                label: 'Réseau de sociétés à même adresse',
                description: `${group.length} sociétés domiciliées à la même adresse (${addr.slice(0, 60)})${hasHolding ? ', dont une holding' : ''} — structure d\'optimisation fiscale agressive.`,
                evidence: group,
            });
        }
    }
    // ── Pattern 4 : Micro-entreprises multiples (fractionnement CA) ───────────
    const activeSoleTraders = active.filter(c => c.isSoleTrader);
    if (activeSoleTraders.length >= 3) {
        patterns.push({
            type: 'micro_split',
            severity: 'high',
            label: 'Fractionnement d\'activité (micro-entreprises multiples)',
            description: `${activeSoleTraders.length} auto-entreprises/EI actives — pratique parfois utilisée pour rester sous les seuils de TVA ou de cotisations.`,
            evidence: activeSoleTraders,
        });
    }
    // ── Pattern 5 : Entreprises à durée de vie courte (< 18 mois) ────────────
    const shortLived = closed.filter(c => c.lifespanMonths !== undefined && c.lifespanMonths < 18);
    if (shortLived.length >= 2) {
        patterns.push({
            type: 'short_lived',
            severity: 'high',
            label: 'Sociétés à durée de vie courte',
            description: `${shortLived.length} entreprises fermées en moins de 18 mois — peut indiquer des sociétés-tampons créées pour des opérations ponctuelles (facturation, cession d'actifs, etc.).`,
            evidence: shortLived,
        });
    }
    // ── Pattern 6 : Holding pure sans salarié ────────────────────────────────
    const pureHoldings = active.filter(c => c.isHolding && !c.isSoleTrader);
    if (pureHoldings.length >= 1 && active.length >= 3) {
        patterns.push({
            type: 'pure_holding',
            severity: 'medium',
            label: 'Structure holding active',
            description: `${pureHoldings.length} société(s) holding (${pureHoldings.map(h => h.name).join(', ')}) parmi ${active.length} entités actives — structure d'optimisation fiscale courante mais à vérifier.`,
            evidence: pureHoldings,
        });
    }
    return patterns;
}
// ─── 5. Agrégateur principal ──────────────────────────────────────────────────
async function checkCompanyIntelligence(input) {
    const base = {
        id: 'company_intelligence',
        source: 'INSEE / BODACC',
        sourceLabel: 'Intelligence entreprises (anti-évasion)',
        category: 'sanctions',
        confidence: 0.85,
        url: `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(`${input.prenom} ${input.nom}`)}`,
        checkedAt: new Date(),
    };
    try {
        const [inseeResult, societeResult] = await Promise.allSettled([
            queryINSEE(input.nom, input.prenom),
            querySocieteCom(input.nom, input.prenom),
        ]);
        let companies = [
            ...(inseeResult.status === 'fulfilled' ? inseeResult.value : []),
            ...(societeResult.status === 'fulfilled' ? societeResult.value : []),
        ];
        // Déduplique par SIREN
        const seenSiren = new Set();
        companies = companies.filter(c => {
            if (!c.siren)
                return true;
            if (seenSiren.has(c.siren))
                return false;
            seenSiren.add(c.siren);
            return true;
        });
        // Cross-reference BODACC pour les entreprises fermées (best-effort)
        await Promise.allSettled(companies
            .filter(c => c.status === 'closed' && c.siren)
            .slice(0, 5) // max 5 requêtes BODACC
            .map(async (c) => {
            const bodaccStatus = await queryBODACCBySiren(c.siren);
            if (bodaccStatus === 'liquidation')
                c.status = 'liquidation';
            else if (bodaccStatus === 'redressement')
                c.status = 'closed';
        }));
        if (companies.length === 0) {
            return {
                ...base,
                status: 'clear',
                summary: 'Aucune entreprise trouvée',
                details: `Aucune entité associée à ${input.prenom} ${input.nom} dans les registres officiels (INSEE, Société.com).`,
                matches: [],
            };
        }
        const patterns = detectPatterns(companies);
        const active = companies.filter(c => c.status === 'active').length;
        const closed = companies.filter(c => c.status !== 'active').length;
        (0, logger_1.logSystemEvent)({
            action: 'ocr_progress',
            component: 'companyIntelligence',
            details: { total: companies.length, active, closed, patterns: patterns.length },
            severity: 'info',
        });
        if (patterns.length === 0) {
            return {
                ...base,
                status: 'clear',
                summary: `${companies.length} entité(s) — aucun schéma suspect détecté`,
                details: `${active} active(s), ${closed} fermée(s). Activités: ${[...new Set(companies.map(c => c.activityLabel).filter(Boolean))].slice(0, 4).join(', ')}.`,
                matches: companies,
            };
        }
        const critical = patterns.filter(p => p.severity === 'critical');
        const high = patterns.filter(p => p.severity === 'high');
        const topStatus = critical.length > 0 ? 'alert' : high.length > 0 ? 'alert' : 'warning';
        const detailLines = patterns.slice(0, 4).map(p => `⚠ [${p.severity.toUpperCase()}] ${p.label}: ${p.description}`);
        detailLines.push('', `Entreprises (${companies.length} total, ${active} actives, ${closed} fermées):`, ...companies.slice(0, 8).map(c => `  • ${c.name} (${c.status === 'active' ? '✓ active' : '✗ fermée'}${c.dateCreation ? ` — créée ${c.dateCreation}` : ''}${c.lifespanMonths ? ` — ${c.lifespanMonths}m` : ''}) [${c.activityLabel ?? c.activity}]`));
        return {
            ...base,
            status: topStatus,
            summary: `${patterns.length} schéma(s) détecté(s) — ${critical.length} critique(s) sur ${companies.length} entité(s)`,
            details: detailLines.join('\n'),
            matches: companies,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, logger_1.logSystemEvent)({ action: 'ocr_error', component: 'companyIntelligence', details: { error: msg }, severity: 'warning' });
        return { ...base, status: 'error', summary: 'Service indisponible', details: `Intelligence entreprises: ${msg}`, matches: [] };
    }
}
//# sourceMappingURL=companyIntelligenceService.js.map