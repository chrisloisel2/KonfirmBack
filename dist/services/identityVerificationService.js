"use strict";
/**
 * Identity Verification Service
 *
 * Runs parallel checks against open APIs and public sources:
 *   1. Document format & expiry (offline)
 *   2. OpenSanctions (sanctions + PEP, free 500 req/day)
 *   3. OFAC SDN (US Treasury, free)
 *   4. EU Financial Sanctions (europa.eu, free)
 *   5. Interpol Red Notices (public API, free)
 *   6. DuckDuckGo Instant Answer (reputation, free)
 *   7. Wikipedia PEP check (free API)
 *   8. Web Crawling multi-sources (Google News, BODACC, Bing, Qwant, Presse FR)
 *   9. Intelligence entreprises (INSEE/BODACC — évasion fiscale, phoenix, holding)
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
exports.verifyIdentity = verifyIdentity;
exports.verifyIdentityLCBFT = verifyIdentityLCBFT;
const axios_1 = __importDefault(require("axios"));
const cheerio = __importStar(require("cheerio"));
const logger_1 = require("../utils/logger");
const webReputationService_1 = require("./webReputationService");
const companyIntelligenceService_1 = require("./companyIntelligenceService");
const seuilsLcbFtService_1 = require("./seuilsLcbFtService");
// ─── 1. Document validation (offline) ────────────────────────────────────────
function checkDocument(input) {
    const issues = [];
    // Expiry check
    if (input.dateExpiration) {
        const [d, m, y] = input.dateExpiration.split('/').map(Number);
        const expiry = new Date(y, m - 1, d);
        const today = new Date();
        if (expiry < today) {
            issues.push(`Document expiré depuis le ${input.dateExpiration}`);
        }
        else {
            const daysLeft = Math.floor((expiry.getTime() - today.getTime()) / 86400000);
            if (daysLeft < 90)
                issues.push(`Document expire dans ${daysLeft} jours`);
        }
    }
    // Document number format
    if (input.docType === 'cni') {
        if (!/^\d{12}$/.test(input.numeroDocument) && !/^[0-9A-Z]{9,12}$/.test(input.numeroDocument)) {
            issues.push('Format numéro CNI inhabituel');
        }
    }
    else {
        if (!/^[A-Z0-9]{8,9}$/.test(input.numeroDocument.toUpperCase())) {
            issues.push('Format numéro passeport inhabituel');
        }
    }
    // Age plausibility
    if (input.dateNaissance) {
        const [d, m, y] = input.dateNaissance.split('/').map(Number);
        const dob = new Date(y, m - 1, d);
        const age = (Date.now() - dob.getTime()) / (365.25 * 86400000);
        if (age < 0 || age > 120)
            issues.push('Date de naissance implausible');
    }
    const status = issues.length > 0
        ? (issues.some(i => i.includes('expiré')) ? 'alert' : 'warning')
        : 'clear';
    return {
        id: 'document_validity',
        source: 'Validation locale',
        sourceLabel: 'Validité du document',
        category: 'document',
        status,
        summary: issues.length === 0 ? 'Document valide' : issues[0],
        details: issues.length === 0
            ? `${input.docType === 'cni' ? 'Carte nationale d\'identité' : 'Passeport'} — format et dates conformes`
            : issues.join(' · '),
        confidence: 1,
        checkedAt: new Date(),
    };
}
// ─── 2. OpenSanctions (sanctions + PEP) ──────────────────────────────────────
async function checkOpenSanctions(input) {
    const base = {
        id: 'opensanctions',
        source: 'OpenSanctions',
        sourceLabel: 'Sanctions & PPE (OpenSanctions)',
        category: 'sanctions',
        confidence: 0.92,
        url: 'https://www.opensanctions.org',
        checkedAt: new Date(),
    };
    try {
        const fullName = `${input.prenom} ${input.nom}`.trim();
        const apiKey = process.env.OPENSANCTIONS_API_KEY ?? '';
        const body = {
            queries: {
                q1: {
                    schema: 'Person',
                    properties: {
                        name: [fullName],
                        ...(input.dateNaissance ? { birthDate: [frToIso(input.dateNaissance)] } : {}),
                    },
                },
            },
        };
        const res = await axios_1.default.post('https://api.opensanctions.org/match/default', body, {
            params: { threshold: 0.7 },
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
            },
            timeout: 8000,
        });
        const results = res.data?.responses?.q1?.results ?? [];
        if (results.length === 0) {
            return { ...base, status: 'clear', summary: 'Aucun résultat', details: 'Non répertorié dans les listes de sanctions ou PPE.', matches: [] };
        }
        const sanctionMatches = results.filter((r) => r.datasets?.includes('sanctions'));
        const pepMatches = results.filter((r) => r.datasets?.some((d) => d.includes('pep')));
        const topScore = results[0]?.score ?? 0;
        if (sanctionMatches.length > 0) {
            return {
                ...base,
                category: 'sanctions',
                status: topScore > 0.9 ? 'alert' : 'warning',
                summary: `${sanctionMatches.length} correspondance(s) sanctions`,
                details: `Score max: ${Math.round(topScore * 100)}% — Sources: ${sanctionMatches.map((r) => r.datasets.join(', ')).join(' | ')}`,
                matches: sanctionMatches,
            };
        }
        if (pepMatches.length > 0) {
            return {
                ...base,
                category: 'pep',
                status: 'warning',
                summary: `${pepMatches.length} correspondance(s) PPE`,
                details: `Score max: ${Math.round(topScore * 100)}% — ${pepMatches[0].caption ?? ''}`,
                matches: pepMatches,
            };
        }
        return { ...base, status: 'clear', summary: 'Aucune correspondance significative', details: `${results.length} résultat(s) avec score < 70%.`, matches: results };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const is401 = err?.response?.status === 401;
        (0, logger_1.logSystemEvent)({ action: 'ocr_error', component: 'opensanctions', details: { error: msg }, severity: 'warning' });
        return {
            ...base,
            status: 'error',
            summary: is401 ? 'Clé API manquante' : 'Service indisponible',
            details: is401
                ? 'OpenSanctions nécessite une clé API. Inscrivez-vous gratuitement sur opensanctions.org/api et ajoutez OPENSANCTIONS_API_KEY dans votre .env'
                : `OpenSanctions: ${msg}`,
            matches: [],
        };
    }
}
// ─── 3. OFAC SDN (US Treasury) ───────────────────────────────────────────────
async function checkOFAC(input) {
    const base = {
        id: 'ofac_sdn',
        source: 'OFAC SDN',
        sourceLabel: 'Liste OFAC (Trésor US)',
        category: 'sanctions',
        confidence: 0.95,
        url: 'https://sanctionssearch.ofac.treas.gov/',
        checkedAt: new Date(),
    };
    try {
        const fullName = encodeURIComponent(`${input.prenom} ${input.nom}`);
        const res = await axios_1.default.get(`https://sanctionssearch.ofac.treas.gov/SdnList.aspx?Program=ALL&Name=${fullName}&Type=individual`, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KonfirmApp/1.0)' } });
        const $ = cheerio.load(res.data);
        const rows = $('#gvSearchResults tr').length - 1; // subtract header
        if (rows > 0) {
            const names = $('#gvSearchResults tr:not(:first-child) td:first-child').map((_, el) => $(el).text().trim()).get();
            return {
                ...base,
                status: 'alert',
                summary: `${rows} entrée(s) sur la liste OFAC SDN`,
                details: `Noms correspondants: ${names.slice(0, 3).join(', ')}`,
                matches: names,
            };
        }
        return { ...base, status: 'clear', summary: 'Absent de la liste OFAC', details: 'Non répertorié sur la SDN List (Specially Designated Nationals).', matches: [] };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...base, status: 'error', summary: 'Service indisponible', details: `OFAC: ${msg}`, matches: [] };
    }
}
// ─── 4. Interpol Red Notices ─────────────────────────────────────────────────
async function checkInterpol(input) {
    const base = {
        id: 'interpol',
        source: 'Interpol',
        sourceLabel: 'Notices rouges Interpol',
        category: 'judicial',
        confidence: 0.90,
        url: 'https://www.interpol.int/en/How-we-work/Notices/View-Red-Notices',
        checkedAt: new Date(),
    };
    try {
        const res = await axios_1.default.get('https://ws-public.interpol.int/notices/v1/red', {
            params: {
                name: input.nom,
                forename: input.prenom,
                ...(input.dateNaissance ? { ageMin: getAge(input.dateNaissance) - 2, ageMax: getAge(input.dateNaissance) + 2 } : {}),
                resultPerPage: 10,
            },
            timeout: 10000,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Referer': 'https://www.interpol.int/',
            },
        });
        const total = res.data?.total ?? 0;
        const notices = res.data?._embedded?.notices ?? [];
        if (total === 0) {
            return { ...base, status: 'clear', summary: 'Aucune notice rouge', details: 'Non recherché par Interpol.', matches: [] };
        }
        return {
            ...base,
            status: 'alert',
            summary: `${total} notice(s) rouge(s) potentielle(s)`,
            details: notices.slice(0, 3).map((n) => `${n.forename ?? ''} ${n.name ?? ''} (${n.entity_id})`).join(' | '),
            matches: notices,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...base, status: 'error', summary: 'Service indisponible', details: `Interpol: ${msg}`, matches: [] };
    }
}
// ─── 5. Wikipedia PEP check ──────────────────────────────────────────────────
async function checkWikipediaPEP(input) {
    const base = {
        id: 'wikipedia_pep',
        source: 'Wikipedia',
        sourceLabel: 'Personnalité politique (Wikipedia)',
        category: 'pep',
        confidence: 0.65,
        url: 'https://fr.wikipedia.org',
        checkedAt: new Date(),
    };
    const PEP_KEYWORDS = [
        'ministre', 'président', 'député', 'sénateur', 'maire', 'préfet',
        'ambassadeur', 'directeur général', 'secrétaire d\'état', 'élu',
        'conseiller régional', 'conseiller départemental', 'parlementaire',
        'premier ministre', 'gouverneur', 'juge', 'magistrat',
    ];
    try {
        const query = `${input.prenom} ${input.nom}`;
        const searchRes = await axios_1.default.get('https://fr.wikipedia.org/w/api.php', {
            params: { action: 'query', list: 'search', srsearch: query, srlimit: 3, format: 'json', origin: '*' },
            timeout: 6000,
            headers: {
                'User-Agent': 'KonfirmApp/1.0 (contact@konfirm.fr) axios/node.js',
                'Api-User-Agent': 'KonfirmApp/1.0 (contact@konfirm.fr)',
            },
        });
        const hits = searchRes.data?.query?.search ?? [];
        if (hits.length === 0) {
            return { ...base, status: 'clear', summary: 'Non trouvé sur Wikipedia', details: 'Aucune page Wikipedia correspondante.', matches: [] };
        }
        const topHit = hits[0];
        const snippet = (topHit.snippet ?? '').toLowerCase();
        const title = topHit.title ?? '';
        const isPEP = PEP_KEYWORDS.some(kw => snippet.includes(kw) || title.toLowerCase().includes(kw));
        return {
            ...base,
            status: isPEP ? 'warning' : 'clear',
            summary: isPEP ? `PPE potentielle — "${title}"` : `Présent sur Wikipedia (non PPE)`,
            details: cheerio.load(topHit.snippet ?? '')('body').text().slice(0, 200),
            url: `https://fr.wikipedia.org/wiki/${encodeURIComponent(title)}`,
            matches: hits,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...base, status: 'error', summary: 'Service indisponible', details: `Wikipedia: ${msg}`, matches: [] };
    }
}
// ─── 6. DuckDuckGo reputation check ─────────────────────────────────────────
async function checkReputation(input) {
    const base = {
        id: 'reputation_web',
        source: 'DuckDuckGo',
        sourceLabel: 'Réputation web',
        category: 'reputation',
        confidence: 0.5,
        url: 'https://duckduckgo.com',
        checkedAt: new Date(),
    };
    const NEGATIVE_KEYWORDS = [
        'fraude', 'escroquerie', 'condamné', 'arrestation', 'garde à vue',
        'mis en examen', 'détournement', 'corruption', 'blanchiment', 'trafic',
        'fraud', 'arrested', 'convicted', 'money laundering', 'bribery',
    ];
    try {
        const query = `"${input.prenom} ${input.nom}"`;
        const res = await axios_1.default.get('https://api.duckduckgo.com/', {
            params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
            timeout: 6000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KonfirmApp/1.0)' },
        });
        const abstract = (res.data?.Abstract ?? '').toLowerCase();
        const relatedTopics = res.data?.RelatedTopics ?? [];
        const allText = [abstract, ...relatedTopics.map((t) => (t.Text ?? '').toLowerCase())].join(' ');
        const hits = NEGATIVE_KEYWORDS.filter(kw => allText.includes(kw));
        const hasNegative = hits.length > 0;
        return {
            ...base,
            status: hasNegative ? 'warning' : 'clear',
            summary: hasNegative
                ? `${hits.length} terme(s) négatif(s) détecté(s)`
                : 'Aucun élément négatif détecté',
            details: hasNegative
                ? `Mots-clés: ${hits.join(', ')}`
                : `Recherche web "${input.prenom} ${input.nom}" — aucun résultat préoccupant.`,
            url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
            matches: hits,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...base, status: 'error', summary: 'Service indisponible', details: `DuckDuckGo: ${msg}`, matches: [] };
    }
}
// ─── 7. EU Financial Sanctions ───────────────────────────────────────────────
async function checkEUSanctions(input) {
    const base = {
        id: 'eu_sanctions',
        source: 'UE — FSRB',
        sourceLabel: 'Sanctions financières UE',
        category: 'sanctions',
        confidence: 0.95,
        url: 'https://webgate.ec.europa.eu/fsd/fsf',
        checkedAt: new Date(),
    };
    try {
        const nomLower = input.nom.toLowerCase();
        const prenomLower = input.prenom.toLowerCase();
        // Fetch RSS first to get the current access token
        const rss = await axios_1.default.get('https://webgate.ec.europa.eu/fsd/fsf/public/rss', {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KonfirmApp/1.0)' },
        });
        const tokenMatch = rss.data.match(/token=([A-Za-z0-9+/=]+)/);
        const token = tokenMatch?.[1] ?? 'dG9rZW4tMjAxNw';
        const res = await axios_1.default.get(`https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=${token}`, {
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KonfirmApp/1.0)' },
            responseType: 'text',
        });
        const $ = cheerio.load(res.data, { xmlMode: true });
        const matches = [];
        $('nameAlias').each((_, el) => {
            const wholeName = ($(el).attr('wholeName') ?? '').toLowerCase();
            const firstName = ($(el).attr('firstName') ?? '').toLowerCase();
            const lastName = ($(el).attr('lastName') ?? '').toLowerCase();
            if ((lastName.includes(nomLower) && firstName.includes(prenomLower)) ||
                (wholeName.includes(nomLower) && wholeName.includes(prenomLower))) {
                matches.push($(el).attr('wholeName') ?? '');
            }
        });
        if (matches.length === 0) {
            return { ...base, status: 'clear', summary: 'Absent des sanctions UE', details: 'Non répertorié dans la liste consolidée des sanctions financières de l\'Union Européenne.', matches: [] };
        }
        return {
            ...base,
            status: 'alert',
            summary: `${matches.length} entrée(s) dans les sanctions UE`,
            details: matches.slice(0, 3).join(' | '),
            matches,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...base, status: 'error', summary: 'Service indisponible', details: `Sanctions UE: ${msg}`, matches: [] };
    }
}
// ─── Orchestrator ─────────────────────────────────────────────────────────────
async function verifyIdentity(input) {
    (0, logger_1.logSystemEvent)({
        action: 'ocr_progress',
        component: 'identityVerification',
        details: { nom: input.nom, prenom: input.prenom, docType: input.docType },
        severity: 'info',
    });
    const [docResult, opensanctions, ofac, interpol, wikipedia, reputation, euSanctions, webReputation, companyIntel] = await Promise.allSettled([
        Promise.resolve(checkDocument(input)),
        checkOpenSanctions(input),
        checkOFAC(input),
        checkInterpol(input),
        checkWikipediaPEP(input),
        checkReputation(input),
        checkEUSanctions(input),
        (0, webReputationService_1.checkWebReputation)(input),
        (0, companyIntelligenceService_1.checkCompanyIntelligence)(input),
    ]);
    const results = [docResult, opensanctions, ofac, interpol, wikipedia, reputation, euSanctions, webReputation, companyIntel].map(r => r.status === 'fulfilled' ? r.value : ({
        id: 'unknown',
        source: 'Erreur',
        sourceLabel: 'Erreur',
        category: 'sanctions',
        status: 'error',
        summary: 'Vérification échouée',
        details: r.reason?.message ?? 'Erreur inconnue',
        confidence: 0,
        matches: [],
        checkedAt: new Date(),
    }));
    (0, logger_1.logSystemEvent)({
        action: 'ocr_progress',
        component: 'identityVerification',
        details: {
            totalChecks: results.length,
            alerts: results.filter(r => r.status === 'alert').length,
            warnings: results.filter(r => r.status === 'warning').length,
        },
        severity: 'info',
    });
    return results;
}
// ─── Vérification LCB-FT complète ──────────────────────────────────────────────
/**
 * Effectue une vérification complète selon les procédures GODECHOT PAULIET LCB-FT
 * Inclut obligatoirement la vérification DG Trésor pour conformité réglementaire
 */
async function verifyIdentityLCBFT(input) {
    (0, logger_1.logSystemEvent)({
        action: 'lcb_ft_verification_start',
        component: 'identityVerificationService',
        details: {
            nom: input.nom,
            prenom: input.prenom,
            docType: input.docType,
            procedure: 'GODECHOT PAULIET LCB-FT'
        },
        severity: 'info',
    });
    // Lancement de toutes les vérifications en parallèle
    const [docResult, opensanctions, ofac, interpol, wikipedia, reputation, euSanctions, webReputation, companyIntel, dgTresorResult] = await Promise.allSettled([
        Promise.resolve(checkDocument(input)),
        checkOpenSanctions(input),
        checkOFAC(input),
        checkInterpol(input),
        checkWikipediaPEP(input),
        checkReputation(input),
        checkEUSanctions(input),
        (0, webReputationService_1.checkWebReputation)(input),
        (0, companyIntelligenceService_1.checkCompanyIntelligence)(input),
        // VÉRIFICATION OBLIGATOIRE DG TRÉSOR selon procédures GODECHOT PAULIET
        (0, seuilsLcbFtService_1.checkGelAvoirsDGTresor)(`${input.prenom} ${input.nom}`)
    ]);
    // Conversion des résultats avec gestion des erreurs
    const allResults = [
        docResult, opensanctions, ofac, interpol, wikipedia,
        reputation, euSanctions, webReputation, companyIntel
    ].map(r => r.status === 'fulfilled' ? r.value : ({
        id: 'unknown',
        source: 'Erreur',
        sourceLabel: 'Erreur de vérification',
        category: 'sanctions',
        status: 'error',
        summary: 'Vérification échouée',
        details: r.reason?.message ?? 'Erreur inconnue',
        confidence: 0,
        matches: [],
        checkedAt: new Date(),
    }));
    // Ajout spécifique du résultat DG Trésor
    if (dgTresorResult.status === 'fulfilled') {
        const dgResult = dgTresorResult.value;
        allResults.push({
            id: 'dg_tresor_gel_avoirs',
            source: 'DG Trésor',
            sourceLabel: 'Gel des avoirs (DG Trésor)',
            category: 'sanctions',
            status: dgResult.isListed ? 'alert' : 'clear',
            summary: dgResult.isListed
                ? `AVOIRS GELÉS - ${dgResult.matches?.length || 0} correspondance(s)`
                : 'Aucun gel des avoirs',
            details: dgResult.isListed
                ? `Personne inscrite sur le registre des gels d'avoirs. Matches: ${dgResult.matches?.map(m => m.name).join(', ') || 'N/A'}`
                : 'Aucune inscription trouvée sur le registre DG Trésor du gel des avoirs.',
            confidence: 0.98, // Très haute confiance sur les données officielles
            url: 'https://gels-avoirs.dgtresor.gouv.fr/',
            matches: dgResult.matches || [],
            checkedAt: new Date(),
        });
    }
    else {
        // En cas d'erreur de la vérification DG Trésor
        allResults.push({
            id: 'dg_tresor_gel_avoirs',
            source: 'DG Trésor',
            sourceLabel: 'Gel des avoirs (DG Trésor)',
            category: 'sanctions',
            status: 'error',
            summary: 'Service DG Trésor indisponible',
            details: `ATTENTION: Vérification DG Trésor échouée. Erreur: ${dgTresorResult.reason?.message || 'Inconnue'}`,
            confidence: 0,
            matches: [],
            checkedAt: new Date(),
        });
    }
    // Logging des résultats pour audit de conformité
    (0, logger_1.logSystemEvent)({
        action: 'lcb_ft_verification_complete',
        component: 'identityVerificationService',
        details: {
            totalChecks: allResults.length,
            alerts: allResults.filter(r => r.status === 'alert').length,
            warnings: allResults.filter(r => r.status === 'warning').length,
            errors: allResults.filter(r => r.status === 'error').length,
            dgTresorStatus: dgTresorResult.status === 'fulfilled' ? 'success' : 'error',
            complianceFramework: 'GODECHOT PAULIET LCB-FT'
        },
        severity: 'info',
    });
    return allResults;
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
function frToIso(frDate) {
    const [d, m, y] = frDate.split('/');
    return `${y}-${m}-${d}`;
}
function getAge(frDate) {
    const [d, m, y] = frDate.split('/').map(Number);
    return Math.floor((Date.now() - new Date(y, m - 1, d).getTime()) / (365.25 * 86400000));
}
//# sourceMappingURL=identityVerificationService.js.map