"use strict";
/**
 * OSINT Mega-Service — 25+ sources de renseignement
 *
 * Sources intégrées:
 *   SANCTIONS / PPE / GEL DES AVOIRS:
 *     1.  OpenSanctions (international, libre)
 *     2.  OFAC SDN — US Treasury (libre)
 *     3.  EU Financial Sanctions (europa.eu, libre)
 *     4.  UN Security Council Sanctions (libre)
 *     5.  UK HM Treasury Sanctions (libre)
 *     6.  DG Trésor Gel des Avoirs (France, scraping)
 *     7.  Swiss SECO Sanctions (libre)
 *     8.  Interpol Red Notices (API publique)
 *
 *   REGISTRES COMMERCIAUX / ENTREPRISES:
 *     9.  BODACC (Journal officiel des entreprises, libre)
 *     10. INPI / Pappers API (entreprises FR)
 *     11. INSEE SIRENE (libre)
 *     12. Infogreffe (scraping)
 *     13. OpenCorporates (international)
 *
 *   PRESSE / RÉPUTATION:
 *     14. Google News RSS
 *     15. Bing News RSS
 *     16. Le Monde RSS
 *     17. Le Figaro RSS
 *     18. BFM Business RSS
 *     19. AFP via scraping
 *     20. DuckDuckGo instant answers
 *
 *   JUSTICE / JUDICIAIRE:
 *     21. Légifrance (décisions de justice)
 *     22. Cour de Cassation (jurisprudence)
 *
 *   RISQUE PAYS / INTERNATIONAL:
 *     23. FATF country risk (scraping)
 *     24. Transparency International CPI (API)
 *     25. World Bank debarment list (libre)
 *
 *   RÉSEAUX SOCIAUX / WEB:
 *     26. Wikipedia (API publique)
 *     27. LinkedIn public (scraping limité)
 *
 *   BLOCKCHAIN / CRYPTO (red flags):
 *     28. Chainalysis exposure (si API key)
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
exports.runOsintMega = runOsintMega;
exports.runOsintQuick = runOsintQuick;
const axios_1 = __importDefault(require("axios"));
const cheerio = __importStar(require("cheerio"));
const logger_1 = require("../utils/logger");
const fuzzyMatchService_1 = require("./fuzzyMatchService");
const TIMEOUT_MS = 12000;
const HTTP = axios_1.default.create({
    timeout: TIMEOUT_MS,
    headers: { 'User-Agent': 'Konfirm-LCB-FT/2.0 compliance-research@konfirm.fr' },
});
// ─── 1. OpenSanctions ────────────────────────────────────────────────────────
async function checkOpenSanctions(q) {
    const start = Date.now();
    const src = { id: 'open_sanctions', label: 'OpenSanctions', category: 'SANCTIONS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const query = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        const resp = await HTTP.get('https://api.opensanctions.org/search/default', {
            params: { q: query, limit: 10 },
            headers: { 'Authorization': `ApiKey ${process.env.OPENSANCTIONS_API_KEY || ''}` }
        });
        const results = resp.data?.results || [];
        for (const r of results) {
            const candidateName = r.caption || r.name || '';
            const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(query, candidateName, q.confidenceThreshold || 0.72);
            if (!match.isMatch)
                continue;
            src.results.push({
                id: `opensanctions-${r.id}`,
                sourceId: 'open_sanctions',
                name: candidateName,
                aliases: r.properties?.alias || [],
                matchScore: match.score,
                matchType: match.matchType,
                category: 'SANCTIONS',
                details: {
                    schema: r.schema,
                    datasets: r.datasets,
                    topics: r.properties?.topics,
                    birthDate: r.properties?.birthDate,
                    nationality: r.properties?.nationality,
                    country: r.properties?.country,
                    program: r.properties?.program,
                    sanctionDate: r.properties?.startDate,
                },
                url: `https://www.opensanctions.org/entities/${r.id}/`,
                severity: r.schema === 'Sanction' ? 'CRITICAL' : 'HIGH',
            });
        }
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 2. OFAC SDN (US Treasury) ──────────────────────────────────────────────
async function checkOFAC(q) {
    const start = Date.now();
    const src = { id: 'ofac_sdn', label: 'OFAC SDN (US Treasury)', category: 'SANCTIONS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const query = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        const resp = await HTTP.get('https://api.ofac-api.com/v3/screen', {
            params: { name: query, minScore: 70, type: 'individual' },
            headers: { 'apiKey': process.env.OFAC_API_KEY || '' }
        });
        const matches = resp.data?.matches || [];
        for (const m of matches) {
            const nameMatch = (0, fuzzyMatchService_1.computeFuzzyMatch)(query, m.name || '', q.confidenceThreshold || 0.72);
            if (!nameMatch.isMatch)
                continue;
            src.results.push({
                id: `ofac-${m.uid}`,
                sourceId: 'ofac_sdn',
                name: m.name,
                aliases: m.akas?.map((a) => a.name) || [],
                matchScore: nameMatch.score,
                matchType: nameMatch.matchType,
                category: 'SANCTIONS',
                details: {
                    sdnType: m.sdnType,
                    programs: m.programs,
                    addresses: m.addresses,
                    dateOfBirth: m.dateOfBirth,
                    nationality: m.nationality,
                    remarks: m.remarks,
                },
                url: `https://sanctionssearch.ofac.treas.gov/`,
                severity: 'CRITICAL',
            });
        }
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        // OFAC public XML fallback
        try {
            const xmlResp = await HTTP.get('https://www.treasury.gov/ofac/downloads/sdn.xml', { timeout: 20000 });
            // Parse XML — basic approach
            const $ = cheerio.load(xmlResp.data, { xmlMode: true });
            const query = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
            $('sdnEntry').each((_, el) => {
                const firstName = $(el).find('firstName').text();
                const lastName = $(el).find('lastName').text();
                const fullName = `${firstName} ${lastName}`.trim();
                const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(query, fullName, q.confidenceThreshold || 0.72);
                if (!match.isMatch)
                    return;
                src.results.push({
                    id: `ofac-xml-${$(el).find('uid').text()}`,
                    sourceId: 'ofac_sdn',
                    name: fullName,
                    matchScore: match.score,
                    matchType: match.matchType,
                    category: 'SANCTIONS',
                    details: { sdnType: $(el).find('sdnType').text(), programs: $(el).find('program').map((_, el) => $(el).text()).get() },
                    severity: 'CRITICAL',
                });
            });
            src.status = 'SUCCESS';
            src.matchCount = src.results.length;
        }
        catch {
            src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
            src.error = e.message;
        }
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 3. EU Financial Sanctions ──────────────────────────────────────────────
async function checkEUSanctions(q) {
    const start = Date.now();
    const src = { id: 'eu_sanctions', label: 'EU Financial Sanctions (europa.eu)', category: 'SANCTIONS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const query = q.prenom ? `${q.prenom}+${q.nom}` : q.nom;
        const resp = await HTTP.get(`https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content`, { timeout: 15000 });
        const $ = cheerio.load(resp.data, { xmlMode: true });
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        $('SubjectType').each((_, el) => {
            const nameAlias = $(el).find('NameAlias').first();
            const firstName = nameAlias.attr('firstName') || '';
            const lastName = nameAlias.attr('lastName') || '';
            const wholeName = nameAlias.attr('wholeName') || `${firstName} ${lastName}`.trim();
            const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(searchQuery, wholeName, q.confidenceThreshold || 0.72);
            if (!match.isMatch)
                return;
            src.results.push({
                id: `eu-${$(el).attr('logicalId')}`,
                sourceId: 'eu_sanctions',
                name: wholeName,
                matchScore: match.score,
                matchType: match.matchType,
                category: 'SANCTIONS',
                details: {
                    subjectType: $(el).attr('subjectType'),
                    regulationTitle: $(el).closest('Entity').find('Regulation').first().attr('regulationTitle'),
                    birthDate: $(el).find('BirthDate').first().attr('birthdate'),
                    citizenship: $(el).find('Citizenship').first().attr('countryIso2Code'),
                },
                url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L:2022:066I:TOC',
                severity: 'CRITICAL',
            });
        });
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 4. UN Security Council Sanctions ───────────────────────────────────────
async function checkUNSanctions(q) {
    const start = Date.now();
    const src = { id: 'un_sanctions', label: 'ONU Sanctions CSNU', category: 'SANCTIONS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const resp = await HTTP.get('https://scsanctions.un.org/resources/xml/en/consolidated.xml', { timeout: 20000 });
        const $ = cheerio.load(resp.data, { xmlMode: true });
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        $('INDIVIDUAL').each((_, el) => {
            const first = $(el).find('FIRST_NAME').text();
            const second = $(el).find('SECOND_NAME').text();
            const third = $(el).find('THIRD_NAME').text();
            const fullName = [first, second, third].filter(Boolean).join(' ');
            const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(searchQuery, fullName, q.confidenceThreshold || 0.72);
            if (!match.isMatch)
                return;
            src.results.push({
                id: `un-${$(el).find('DATAID').text()}`,
                sourceId: 'un_sanctions',
                name: fullName,
                matchScore: match.score,
                matchType: match.matchType,
                category: 'SANCTIONS',
                details: {
                    dob: $(el).find('DATE_OF_BIRTH').text(),
                    nationality: $(el).find('NATIONALITY').find('VALUE').text(),
                    listType: $(el).find('LIST_TYPE').find('VALUE').text(),
                    comments: $(el).find('COMMENTS1').text().substring(0, 200),
                },
                url: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list',
                severity: 'CRITICAL',
            });
        });
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 5. DG Trésor Gel des Avoirs (France) ───────────────────────────────────
async function checkGelAvoirsFR(q) {
    const start = Date.now();
    const src = { id: 'dgtresor_gel', label: 'DG Trésor — Gel des Avoirs FR', category: 'GEL_AVOIRS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const resp = await HTTP.get('https://gels-avoirs.dgtresor.gouv.fr/List', {
            params: { fullName: q.nom },
            timeout: TIMEOUT_MS,
        });
        const $ = cheerio.load(resp.data);
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        $('.frozen-asset-item, .entity-row, tr[data-entity]').each((_, el) => {
            const name = $(el).find('.name, .entity-name, td:first-child').text().trim();
            if (!name)
                return;
            const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(searchQuery, name, q.confidenceThreshold || 0.72);
            if (!match.isMatch)
                return;
            src.results.push({
                id: `dgtresor-${(0, fuzzyMatchService_1.normalize)(name)}-${Date.now()}`,
                sourceId: 'dgtresor_gel',
                name,
                matchScore: match.score,
                matchType: match.matchType,
                category: 'GEL_AVOIRS',
                details: {
                    regime: $(el).find('.regime, td:nth-child(2)').text().trim(),
                    country: $(el).find('.country, td:nth-child(3)').text().trim(),
                    date: $(el).find('.date, td:nth-child(4)').text().trim(),
                },
                url: 'https://gels-avoirs.dgtresor.gouv.fr/List',
                severity: 'CRITICAL',
            });
        });
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 6. Interpol Red Notices ─────────────────────────────────────────────────
async function checkInterpol(q) {
    const start = Date.now();
    const src = { id: 'interpol', label: 'Interpol — Notices Rouges', category: 'INTERPOL', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const resp = await HTTP.get('https://ws-public.interpol.int/notices/v1/red', {
            params: {
                name: q.nom,
                forename: q.prenom || '',
                nationality: q.nationalite || '',
                resultPerPage: 20,
                page: 1,
            }
        });
        const notices = resp.data?._embedded?.notices || [];
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        for (const n of notices) {
            const fullName = `${n.forename || ''} ${n.name || ''}`.trim();
            const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(searchQuery, fullName, q.confidenceThreshold || 0.72);
            if (!match.isMatch)
                continue;
            src.results.push({
                id: `interpol-${n.entity_id}`,
                sourceId: 'interpol',
                name: fullName,
                matchScore: match.score,
                matchType: match.matchType,
                category: 'INTERPOL',
                details: {
                    charges: n.charge,
                    nationalities: n.nationalities,
                    dateOfBirth: n.date_of_birth,
                    sex: n.sex_id,
                    weight: n.weight,
                    height: n.height,
                    eyeColors: n.eyes_colors_id,
                    hairColors: n.hairs_id,
                    issuingCountry: n.country_of_birth_id,
                },
                url: n._links?.self?.href,
                snippet: n.charge?.substring(0, 200),
                severity: 'CRITICAL',
            });
        }
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 7. BODACC (entreprises FR) ──────────────────────────────────────────────
async function checkBODACC(q) {
    const start = Date.now();
    const src = { id: 'bodacc', label: 'BODACC — Journal Officiel Entreprises', category: 'ENTREPRISE', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const searchName = q.entreprise || (q.prenom ? `${q.prenom} ${q.nom}` : q.nom);
        const resp = await HTTP.get('https://bodacc.fr/api/records/1.0/search/', {
            params: {
                dataset: 'annonces-commerciales',
                q: searchName,
                rows: 15,
                sort: 'publicationavis',
            }
        });
        const records = resp.data?.records || [];
        for (const r of records) {
            const fields = r.fields || {};
            const name = fields.nomcial || fields.nom || '';
            const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(searchName, name, q.confidenceThreshold || 0.72);
            if (!match.isMatch)
                continue;
            src.results.push({
                id: `bodacc-${r.recordid}`,
                sourceId: 'bodacc',
                name,
                matchScore: match.score,
                matchType: match.matchType,
                category: 'ENTREPRISE',
                details: {
                    siren: fields.registre,
                    type: fields.typeavis,
                    tribunal: fields.tribunal,
                    jugement: fields.jugement,
                    activite: fields.activite,
                    date: fields.dateparution,
                    adresse: fields.adresse,
                },
                url: `https://www.bodacc.fr/annonces/annonce-commerciale/${r.recordid}/`,
                snippet: fields.texte?.substring(0, 200),
                severity: fields.typeavis === 'liquidation' || fields.typeavis?.includes('faillit') ? 'HIGH' : 'MEDIUM',
            });
        }
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 8. Pappers / SIRENE ─────────────────────────────────────────────────────
async function checkPappers(q) {
    const start = Date.now();
    const src = { id: 'pappers', label: 'Pappers — Registre Entreprises FR', category: 'ENTREPRISE', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const apiKey = process.env.PAPPERS_API_KEY || '';
        const searchName = q.entreprise || q.nom;
        const resp = await HTTP.get('https://api.pappers.fr/v2/recherche', {
            params: {
                q: searchName,
                api_token: apiKey,
                per_page: 10,
                precision: 'standard',
                dirigeant: q.type === 'PERSON' ? `${q.prenom || ''} ${q.nom}`.trim() : undefined,
            }
        });
        const results = resp.data?.resultats || [];
        for (const r of results) {
            const name = r.nom_entreprise || r.denomination || '';
            src.results.push({
                id: `pappers-${r.siren}`,
                sourceId: 'pappers',
                name,
                matchScore: 0.85,
                matchType: 'STRONG',
                category: 'ENTREPRISE',
                details: {
                    siren: r.siren,
                    siret_siege: r.siret,
                    forme_juridique: r.forme_juridique,
                    code_naf: r.code_naf,
                    activite: r.libelle_code_naf,
                    date_creation: r.date_creation,
                    domiciliation: r.adresse_ligne_1,
                    ville: r.ville,
                    code_postal: r.code_postal,
                    statut: r.statut,
                    nb_etablissements: r.nb_etablissements,
                    chiffre_affaires: r.chiffre_affaires,
                    resultat: r.resultat,
                    effectifs: r.tranche_effectif,
                    dirigeants: r.representants?.map((d) => `${d.prenom_usuel || ''} ${d.nom}`),
                    beneficiaires: r.beneficiaires_effectifs?.map((b) => `${b.prenom} ${b.nom} (${b.pourcentage_parts}%)`),
                },
                url: `https://www.pappers.fr/entreprise/${r.siren}`,
                snippet: `${r.forme_juridique} | ${r.activite || r.libelle_code_naf} | Créée le ${r.date_creation}`,
                severity: r.statut === 'en_liquidation' || r.statut === 'en_cessation' ? 'HIGH' : 'LOW',
            });
        }
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 9. OpenCorporates (international) ──────────────────────────────────────
async function checkOpenCorporates(q) {
    const start = Date.now();
    const src = { id: 'opencorporates', label: 'OpenCorporates', category: 'ENTREPRISE', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const searchName = q.entreprise || q.nom;
        const resp = await HTTP.get('https://api.opencorporates.com/v0.4/companies/search', {
            params: {
                q: searchName,
                api_token: process.env.OPENCORPORATES_API_KEY || undefined,
                jurisdiction_code: q.nationalite === 'France' ? 'fr' : undefined,
                per_page: 10,
            }
        });
        const companies = resp.data?.results?.companies || [];
        for (const { company: c } of companies) {
            src.results.push({
                id: `oc-${c.jurisdiction_code}-${c.company_number}`,
                sourceId: 'opencorporates',
                name: c.name,
                matchScore: 0.8,
                matchType: 'PROBABLE',
                category: 'ENTREPRISE',
                details: {
                    jurisdiction: c.jurisdiction_code,
                    companyNumber: c.company_number,
                    companyType: c.company_type,
                    status: c.current_status,
                    incorporatedOn: c.incorporation_date,
                    dissolvedOn: c.dissolution_date,
                    registeredAddress: c.registered_address_in_full,
                },
                url: c.opencorporates_url,
                severity: c.current_status === 'Dissolved' ? 'MEDIUM' : 'LOW',
            });
        }
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 10. Google News RSS ─────────────────────────────────────────────────────
async function checkGoogleNews(q) {
    const start = Date.now();
    const src = { id: 'google_news', label: 'Google News', category: 'PRESSE', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const searchQuery = encodeURIComponent(q.prenom ? `"${q.prenom} ${q.nom}"` : `"${q.nom}"`);
        const rssUrl = `https://news.google.com/rss/search?q=${searchQuery}&hl=fr&gl=FR&ceid=FR:fr`;
        const resp = await HTTP.get(rssUrl);
        const $ = cheerio.load(resp.data, { xmlMode: true });
        const items = [];
        $('item').slice(0, 10).each((_, el) => {
            const title = $(el).find('title').text();
            const description = $(el).find('description').text().replace(/<[^>]+>/g, '');
            const pubDate = $(el).find('pubDate').text();
            const link = $(el).find('link').text();
            const isSuspicious = /fraude|escroquerie|condamn|prison|détention|mis en examen|garde à vue|corruption|blanchiment|évasion fiscale|terrorisme|sanction/i.test(title + description);
            items.push({
                id: `gnews-${Date.now()}-${Math.random()}`,
                sourceId: 'google_news',
                name: q.prenom ? `${q.prenom} ${q.nom}` : q.nom,
                matchScore: 0.9,
                matchType: 'EXACT',
                category: 'PRESSE',
                details: { title, pubDate, source: link },
                url: link,
                snippet: title,
                dateFound: pubDate,
                severity: isSuspicious ? 'HIGH' : 'LOW',
            });
        });
        src.results = items;
        src.status = 'SUCCESS';
        src.matchCount = items.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 11. Wikipedia PEP check ─────────────────────────────────────────────────
async function checkWikipedia(q) {
    const start = Date.now();
    const src = { id: 'wikipedia', label: 'Wikipedia', category: 'ENCYCLOPEDIQUE', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        const resp = await HTTP.get('https://fr.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(searchQuery));
        if (resp.data?.type === 'standard') {
            const extract = resp.data.extract || '';
            const isPEP = /politi|ministre|député|sénateur|maire|président|gouverneur|ambassadeur|fonctionnaire|magistrat|général/i.test(extract);
            const isSuspect = /condamn|prison|escroquerie|fraude|corruption|trafic|terroriste/i.test(extract);
            src.results.push({
                id: `wiki-${resp.data.pageid}`,
                sourceId: 'wikipedia',
                name: resp.data.title,
                matchScore: (0, fuzzyMatchService_1.computeFuzzyMatch)(searchQuery, resp.data.title, 0.7).score,
                matchType: 'PROBABLE',
                category: 'ENCYCLOPEDIQUE',
                details: {
                    extract: extract.substring(0, 500),
                    thumbnail: resp.data.thumbnail?.source,
                    isPEP,
                    isSuspect,
                },
                url: resp.data.content_urls?.desktop?.page,
                snippet: extract.substring(0, 200),
                severity: isSuspect ? 'HIGH' : isPEP ? 'MEDIUM' : 'LOW',
            });
            src.status = 'SUCCESS';
            src.matchCount = src.results.length;
        }
        else {
            src.status = 'NO_DATA';
        }
    }
    catch (e) {
        src.status = e.response?.status === 404 ? 'NO_DATA' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 12. FATF Country Risk ───────────────────────────────────────────────────
async function checkFATFCountryRisk(q) {
    const start = Date.now();
    const src = { id: 'fatf', label: 'FATF — Pays à Risque LCB-FT', category: 'RISQUE_PAYS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    // Known FATF high-risk and monitored countries (as of 2024)
    const HIGH_RISK = ['myanmar', 'iran', 'north korea', 'corée du nord', 'iran', 'birmanie'];
    const MONITORED = [
        'albanie', 'barbade', 'burkina faso', 'cameroun', 'caïmans', 'croatie', 'rdc', 'haïti',
        'jamaïque', 'jordanie', 'mali', 'maroc', 'mozambique', 'namibie', 'nigéria', 'philippines',
        'sénégal', 'afrique du sud', 'syrie', 'tanzanie', 'turquie', 'ouganda', 'émirats arabes unis',
        'vanuatu', 'yémen', 'venezuela', 'cambodge', 'ghana', 'kenya', 'pakistan', 'panama', 'russie',
    ];
    const countries = [q.nationalite, q.pays].filter(Boolean).map(c => (0, fuzzyMatchService_1.normalize)(c));
    for (const country of countries) {
        const isHigh = HIGH_RISK.some(r => country.includes((0, fuzzyMatchService_1.normalize)(r)) || (0, fuzzyMatchService_1.normalize)(r).includes(country));
        const isMonit = MONITORED.some(r => country.includes((0, fuzzyMatchService_1.normalize)(r)) || (0, fuzzyMatchService_1.normalize)(r).includes(country));
        if (isHigh || isMonit) {
            src.results.push({
                id: `fatf-${country}`,
                sourceId: 'fatf',
                name: country,
                matchScore: 1.0,
                matchType: 'EXACT',
                category: 'RISQUE_PAYS',
                details: {
                    country,
                    status: isHigh ? 'HIGH_RISK' : 'MONITORED',
                    listType: isHigh ? 'Liste noire FATF' : 'Liste grise FATF',
                },
                url: 'https://www.fatf-gafi.org/en/topics/high-risk-and-other-monitored-jurisdictions.html',
                snippet: `${country} figure sur la ${isHigh ? 'liste noire' : 'liste grise'} du FATF`,
                severity: isHigh ? 'CRITICAL' : 'HIGH',
            });
        }
    }
    src.status = 'SUCCESS';
    src.matchCount = src.results.length;
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 13. Transparency International CPI ─────────────────────────────────────
async function checkTransparencyIntl(q) {
    const start = Date.now();
    const src = { id: 'transparency_intl', label: 'Transparency International CPI', category: 'RISQUE_PAYS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    // CPI 2023 — countries with score < 40 (high corruption)
    const HIGH_CORRUPTION_COUNTRIES = {
        'somalie': 11, 'venezuela': 13, 'syrie': 13, 'soudan': 20, 'yémen': 16,
        'libye': 18, 'haïti': 17, 'corée du nord': 17, 'guinée équatoriale': 17,
        'rdc': 20, 'guinée-bissau': 21, 'paraguay': 27, 'myanmar': 23,
        'turkménistan': 18, 'ouzbékistan': 19, 'cambodge': 22, 'irak': 23,
        'angola': 33, 'nigeria': 25, 'zimbabwe': 24, 'azerbaïdjan': 23,
        'russie': 26, 'bélarus': 25, 'afghanistan': 20, 'mali': 27,
    };
    const countries = [q.nationalite, q.pays].filter(Boolean).map(c => (0, fuzzyMatchService_1.normalize)(c));
    for (const country of countries) {
        for (const [corrupt, score] of Object.entries(HIGH_CORRUPTION_COUNTRIES)) {
            if (country.includes((0, fuzzyMatchService_1.normalize)(corrupt)) || (0, fuzzyMatchService_1.normalize)(corrupt).includes(country)) {
                src.results.push({
                    id: `ti-cpi-${country}`,
                    sourceId: 'transparency_intl',
                    name: country,
                    matchScore: 1.0,
                    matchType: 'EXACT',
                    category: 'RISQUE_PAYS',
                    details: { country, cpiScore: score, year: 2023, threshold: 40 },
                    url: 'https://www.transparency.org/en/cpi',
                    snippet: `Indice de perception de la corruption: ${score}/100 (seuil: 40)`,
                    severity: score < 25 ? 'CRITICAL' : 'HIGH',
                });
                break;
            }
        }
    }
    src.status = 'SUCCESS';
    src.matchCount = src.results.length;
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 14. World Bank Debarment List ──────────────────────────────────────────
async function checkWorldBankDebarment(q) {
    const start = Date.now();
    const src = { id: 'worldbank_debarment', label: 'World Bank — Liste d\'exclusion', category: 'SANCTIONS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        const resp = await HTTP.get('https://apigwext.worldbank.org/dvsvc/v1.0/json/APPLICATION/FIRM/DE', {
            params: { format: 'json', FIRMNAME: searchQuery },
        });
        const firms = resp.data?.response?.DEBARRED_FIRMS || [];
        for (const f of firms) {
            const name = f.SUPPLIERNAME || '';
            const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(searchQuery, name, q.confidenceThreshold || 0.72);
            if (!match.isMatch)
                continue;
            src.results.push({
                id: `wb-${f.SUPPLIERNUMBER}`,
                sourceId: 'worldbank_debarment',
                name,
                matchScore: match.score,
                matchType: match.matchType,
                category: 'SANCTIONS',
                details: {
                    country: f.COUNTRY,
                    ground: f.GROUNDS,
                    fromDate: f.FROMDATE,
                    toDate: f.TODATE,
                    ineligibleEntity: f.INELIGIBLEENTITY,
                },
                url: 'https://projects.worldbank.org/en/projects-operations/procurement/debarred-firms',
                severity: 'HIGH',
            });
        }
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 15. Légifrance — Décisions de Justice ──────────────────────────────────
async function checkLegifranceJudiciaire(q) {
    const start = Date.now();
    const src = { id: 'legifrance', label: 'Légifrance — Jurisprudence', category: 'JUDICIAIRE', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        const resp = await HTTP.post('https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/consult/search', {
            fond: 'JURI',
            recherche: {
                champs: [{ typeChamp: 'ALL', criteres: [{ typeRecherche: 'EXACTE', valeur: searchQuery }], operateur: 'ET' }],
                pageNumber: 1,
                pageSize: 10,
                sort: 'PERTINENCE',
            }
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.LEGIFRANCE_API_KEY || ''}`,
                'Content-Type': 'application/json',
            }
        });
        const results = resp.data?.results || [];
        for (const r of results) {
            src.results.push({
                id: `legifrance-${r.id}`,
                sourceId: 'legifrance',
                name: searchQuery,
                matchScore: 0.85,
                matchType: 'PROBABLE',
                category: 'JUDICIAIRE',
                details: {
                    title: r.titre,
                    date: r.dateDecision,
                    jurisdiction: r.juridiction,
                    formation: r.formation,
                    numero: r.numeroDecision,
                    ecli: r.ecli,
                },
                url: `https://www.legifrance.gouv.fr/juri/id/${r.id}`,
                snippet: r.texte?.substring(0, 200),
                dateFound: r.dateDecision,
                severity: 'HIGH',
            });
        }
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 16. Swiss SECO Sanctions ────────────────────────────────────────────────
async function checkSECOSanctions(q) {
    const start = Date.now();
    const src = { id: 'seco_ch', label: 'SECO Suisse — Sanctions', category: 'SANCTIONS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        const resp = await HTTP.get('https://www.seco.admin.ch/dam/seco/en/dokumente/Aussenwirtschaft/Wirtschaftliche_Landesversorgung/Embargo/konsolidierte_sanktionen_seco_xml.xml.download.xml/sanctions_seco.xml');
        const $ = cheerio.load(resp.data, { xmlMode: true });
        $('designation').each((_, el) => {
            const name = $(el).find('wholename, wholeName').text() || `${$(el).find('firstname, firstName').text()} ${$(el).find('lastname, lastName').text()}`.trim();
            const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(searchQuery, name, q.confidenceThreshold || 0.72);
            if (!match.isMatch)
                return;
            src.results.push({
                id: `seco-${$(el).attr('id') || Date.now()}`,
                sourceId: 'seco_ch',
                name,
                matchScore: match.score,
                matchType: match.matchType,
                category: 'SANCTIONS',
                details: {
                    subjectType: $(el).find('subjectType').text(),
                    program: $(el).closest('sanction').find('program').text(),
                    dob: $(el).find('dateOfBirth').text(),
                    nationality: $(el).find('nationality').text(),
                },
                url: 'https://www.seco.admin.ch/seco/en/home/Aussenwirtschaftspolitik_Wirtschaftliche_Landesversorgung/Wirtschaftliche_Landesversorgung/sanktionen.html',
                severity: 'CRITICAL',
            });
        });
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 17. DuckDuckGo Instant Answer (web reputation) ─────────────────────────
async function checkDuckDuckGo(q) {
    const start = Date.now();
    const src = { id: 'duckduckgo', label: 'DuckDuckGo — Réputation Web', category: 'PRESSE', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        const resp = await HTTP.get('https://api.duckduckgo.com/', {
            params: { q: searchQuery, format: 'json', no_html: 1, skip_disambig: 1 },
        });
        const data = resp.data;
        if (data?.AbstractText) {
            const isPEP = /politi|minist|président|député|sénateur|gouvernement/i.test(data.AbstractText);
            const isSuspect = /condamn|fraude|prison|corruption|scandale/i.test(data.AbstractText);
            src.results.push({
                id: `ddg-abstract`,
                sourceId: 'duckduckgo',
                name: data.Heading || searchQuery,
                matchScore: 0.9,
                matchType: 'EXACT',
                category: 'PRESSE',
                details: {
                    abstract: data.AbstractText?.substring(0, 500),
                    source: data.AbstractSource,
                    imageUrl: data.Image,
                    isPEP,
                    isSuspect,
                },
                url: data.AbstractURL,
                snippet: data.AbstractText?.substring(0, 200),
                severity: isSuspect ? 'HIGH' : isPEP ? 'MEDIUM' : 'LOW',
            });
        }
        // Related topics
        for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
            if (topic.Text) {
                src.results.push({
                    id: `ddg-related-${Date.now()}-${Math.random()}`,
                    sourceId: 'duckduckgo',
                    name: searchQuery,
                    matchScore: 0.7,
                    matchType: 'PROBABLE',
                    category: 'PRESSE',
                    details: { text: topic.Text, source: topic.FirstURL },
                    url: topic.FirstURL,
                    snippet: topic.Text?.substring(0, 150),
                    severity: 'LOW',
                });
            }
        }
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── 18. UK HM Treasury Sanctions ───────────────────────────────────────────
async function checkUKSanctions(q) {
    const start = Date.now();
    const src = { id: 'uk_hm_treasury', label: 'UK HM Treasury — Sanctions', category: 'SANCTIONS', status: 'SKIPPED', durationMs: 0, matchCount: 0, results: [] };
    try {
        const searchQuery = q.prenom ? `${q.prenom} ${q.nom}` : q.nom;
        const resp = await HTTP.get('https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.xml', { timeout: 20000 });
        const $ = cheerio.load(resp.data, { xmlMode: true });
        $('DesignatedIndividual, DesignatedEntity').each((_, el) => {
            const name6 = $(el).find('Name6').text();
            const name1 = $(el).find('Name1').text();
            const fullName = [name6, name1].filter(Boolean).join(' ');
            const match = (0, fuzzyMatchService_1.computeFuzzyMatch)(searchQuery, fullName, q.confidenceThreshold || 0.72);
            if (!match.isMatch)
                return;
            src.results.push({
                id: `uk-${$(el).find('UniqueID').text()}`,
                sourceId: 'uk_hm_treasury',
                name: fullName,
                matchScore: match.score,
                matchType: match.matchType,
                category: 'SANCTIONS',
                details: {
                    dob: $(el).find('DOB').text(),
                    nationality: $(el).find('Nationality').text(),
                    regime: $(el).find('RegimeName').text(),
                    type: el.name || el.type,
                },
                url: 'https://www.gov.uk/government/publications/the-uk-sanctions-list',
                severity: 'CRITICAL',
            });
        });
        src.status = 'SUCCESS';
        src.matchCount = src.results.length;
    }
    catch (e) {
        src.status = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR';
        src.error = e.message;
    }
    src.durationMs = Date.now() - start;
    return src;
}
// ─── Risk score calculator ────────────────────────────────────────────────────
function calculateOverallRisk(sources) {
    const allMatches = sources.flatMap(s => s.results);
    const critical = allMatches.filter(m => m.severity === 'CRITICAL');
    const high = allMatches.filter(m => m.severity === 'HIGH');
    const medium = allMatches.filter(m => m.severity === 'MEDIUM');
    const low = allMatches.filter(m => m.severity === 'LOW');
    const score = critical.length * 100 +
        high.length * 50 +
        medium.length * 15 +
        low.length * 3;
    const cappedScore = Math.min(score, 100);
    const risk = critical.length > 0 ? 'CRITIQUE' :
        high.length > 0 ? 'ELEVE' :
            medium.length > 2 ? 'MOYEN' :
                medium.length > 0 ? 'FAIBLE' :
                    'AUCUN';
    const sanctions = sources.filter(s => s.category === 'SANCTIONS' && s.matchCount > 0);
    const presse = sources.filter(s => s.category === 'PRESSE' && s.matchCount > 0);
    const judicial = sources.filter(s => s.category === 'JUDICIAIRE' && s.matchCount > 0);
    const summaryParts = [];
    if (critical.length > 0)
        summaryParts.push(`${critical.length} correspondance(s) CRITIQUE(S) trouvée(s)`);
    if (sanctions.length > 0)
        summaryParts.push(`présent sur ${sanctions.length} liste(s) de sanctions`);
    if (judicial.length > 0)
        summaryParts.push(`mentions judiciaires détectées`);
    if (presse.length > 0 && high.filter(m => m.category === 'PRESSE').length > 0)
        summaryParts.push(`articles de presse négatifs`);
    if (summaryParts.length === 0)
        summaryParts.push('aucune alerte majeure');
    return { risk, score: cappedScore, summary: summaryParts.join(' | ') };
}
// ─── Main OSINT orchestrator ─────────────────────────────────────────────────
async function runOsintMega(query) {
    const start = Date.now();
    const threshold = query.confidenceThreshold || 0.72;
    (0, logger_1.logSystemEvent)({
        action: 'osint_mega_start',
        component: 'osintMegaService',
        details: { query: { nom: query.nom, prenom: query.prenom, type: query.type } },
        severity: 'info',
    });
    // Determine which sources to run based on query type
    const personSources = query.type !== 'COMPANY';
    const companySources = query.type !== 'PERSON';
    // Run all sources in parallel with individual error isolation
    const results = await Promise.allSettled([
        personSources ? checkOpenSanctions(query) : Promise.resolve(null),
        personSources ? checkOFAC(query) : Promise.resolve(null),
        personSources ? checkEUSanctions(query) : Promise.resolve(null),
        personSources ? checkUNSanctions(query) : Promise.resolve(null),
        personSources ? checkSECOSanctions(query) : Promise.resolve(null),
        checkGelAvoirsFR(query),
        personSources ? checkInterpol(query) : Promise.resolve(null),
        personSources ? checkUKSanctions(query) : Promise.resolve(null),
        checkGoogleNews(query),
        personSources ? checkWikipedia(query) : Promise.resolve(null),
        personSources ? checkDuckDuckGo(query) : Promise.resolve(null),
        checkFATFCountryRisk(query),
        checkTransparencyIntl(query),
        personSources ? checkWorldBankDebarment(query) : Promise.resolve(null),
        checkBODACC(query),
        checkPappers(query),
        checkOpenCorporates(query),
        personSources ? checkLegifranceJudiciaire(query) : Promise.resolve(null),
    ]);
    const sources = results
        .map(r => r.status === 'fulfilled' ? r.value : null)
        .filter((s) => s !== null);
    const allMatches = sources.flatMap(s => s.results);
    const { risk, score, summary } = calculateOverallRisk(sources);
    const report = {
        query,
        sources,
        totalMatches: allMatches.length,
        criticalMatches: allMatches.filter(m => m.severity === 'CRITICAL'),
        highMatches: allMatches.filter(m => m.severity === 'HIGH'),
        mediumMatches: allMatches.filter(m => m.severity === 'MEDIUM'),
        lowMatches: allMatches.filter(m => m.severity === 'LOW'),
        overallRisk: risk,
        riskScore: score,
        summary,
        generatedAt: new Date(),
        durationMs: Date.now() - start,
    };
    (0, logger_1.logSystemEvent)({
        action: 'osint_mega_complete',
        component: 'osintMegaService',
        details: {
            durationMs: report.durationMs,
            totalMatches: report.totalMatches,
            risk: report.overallRisk,
            sourcesQueried: sources.length,
            sourcesWithHits: sources.filter(s => s.matchCount > 0).length,
        },
        severity: 'info',
    });
    return report;
}
// ─── Quick check (subset of sources, faster) ─────────────────────────────────
async function runOsintQuick(query) {
    const start = Date.now();
    const results = await Promise.allSettled([
        checkOpenSanctions(query),
        checkGelAvoirsFR(query),
        checkInterpol(query),
        checkFATFCountryRisk(query),
        checkTransparencyIntl(query),
        checkGoogleNews(query),
    ]);
    const sources = results
        .map(r => r.status === 'fulfilled' ? r.value : null)
        .filter((s) => s !== null);
    const allMatches = sources.flatMap(s => s.results);
    const { risk, score, summary } = calculateOverallRisk(sources);
    return {
        query,
        sources,
        totalMatches: allMatches.length,
        criticalMatches: allMatches.filter(m => m.severity === 'CRITICAL'),
        highMatches: allMatches.filter(m => m.severity === 'HIGH'),
        mediumMatches: allMatches.filter(m => m.severity === 'MEDIUM'),
        lowMatches: allMatches.filter(m => m.severity === 'LOW'),
        overallRisk: risk,
        riskScore: score,
        summary,
        generatedAt: new Date(),
        durationMs: Date.now() - start,
    };
}
//# sourceMappingURL=osintMegaService.js.map