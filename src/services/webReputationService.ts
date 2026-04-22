/**
 * Web Reputation & Crawling Service
 *
 * Searches 6 public sources for negative exposure:
 *   1. Google News RSS  — 3 requêtes ciblées (fraude, judiciaire, contrefaçon)
 *   2. BODACC           — Annonces officielles FR (liquidation, redressement)
 *   3. Bing News        — Scraping actualités
 *   4. DuckDuckGo HTML  — Résultats web réels (pas seulement Instant API)
 *   5. Presse française — Le Monde, France Info, 20 Minutes
 *   6. Pappers.fr       — Procédures judiciaires entreprises (optionnel, PAPPERS_API_KEY)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import type { IdentityInput, VerificationResult, VerificationStatus } from './identityVerificationService';
import { logSystemEvent } from '../utils/logger';

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_BOT = 'KonfirmApp/1.0 (contact@konfirm.fr) axios/node.js';

// ─── Dictionnaires de mots-clés par catégorie ─────────────────────────────────

const KW = {
	fraud: ['arnaque', 'arnaques', 'escroquerie', 'escroqueries', 'fraude', 'fraudes', 'frauduleux', 'fraud', 'scam', 'swindle'],
	judicial: ['condamné', 'condamnation', 'mis en examen', 'inculpé', 'jugement', 'tribunal', 'procès', 'peine', 'emprisonné', 'incarcéré', 'arrestation', 'garde à vue', 'convoqué', 'poursuivi', 'perquisition', 'convicted', 'arrested', 'indicted', 'sentenced', 'detained'],
	financial: ['blanchiment', 'détournement', 'abus de confiance', 'corruption', 'faillite', 'liquidation judiciaire', 'redressement judiciaire', 'insolvable', 'surendettement', 'money laundering', 'embezzlement', 'bribery'],
	counterfeit: ['contrefaçon', 'contrefait', 'falsification', 'usurpation d\'identité', 'faux documents', 'counterfeit', 'forgery', 'identity theft'],
	scandal: ['scandale', 'affaire judiciaire', 'mis en cause', 'soupçonné', 'accusé', 'dénoncé', 'plainte', 'complicité', 'recel', 'abus', 'alleged', 'accused', 'suspect', 'investigation'],
};

const ALL_KW = Object.values(KW).flat();

export interface WebHit {
	source: string;
	title: string;
	url: string;
	snippet: string;
	date?: string;
	keywords: string[];
	severity: 'critical' | 'high' | 'medium' | 'low';
}

function detectKeywords(text: string): string[] {
	const lower = text.toLowerCase();
	return ALL_KW.filter(kw => lower.includes(kw));
}

function assessSeverity(kws: string[]): 'critical' | 'high' | 'medium' | 'low' {
	const isCriminal = kws.some(k => ['condamné', 'emprisonné', 'incarcéré', 'convicted', 'sentenced', 'arrested'].includes(k));
	const isJudicial = kws.some(k => KW.judicial.includes(k));
	const isFraud = kws.some(k => KW.fraud.includes(k));
	const isFinancial = kws.some(k => KW.financial.includes(k));
	const isCounterfeit = kws.some(k => KW.counterfeit.includes(k));

	if (isCriminal || (isJudicial && isFraud)) return 'critical';
	if (isJudicial || (isFraud && isFinancial)) return 'high';
	if (isFraud || isFinancial || isCounterfeit) return 'medium';
	return 'low';
}

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9\s-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholeWord(text: string, word: string): boolean {
	if (!word) return false;
	const pattern = new RegExp(`(^|\\s)${escapeRegExp(word)}(?=\\s|$)`);
	return pattern.test(text);
}

function getNameTokens(fullName: string): string[] {
	return normalizeText(fullName)
		.split(' ')
		.map(t => t.trim())
		.filter(t => t.length >= 2);
}

function isRelevantPersonMention(fullName: string, text: string): boolean {
	const normalizedText = normalizeText(text);
	if (!normalizedText) return false;

	const tokens = getNameTokens(fullName);
	if (tokens.length < 2) return false;

	const full = normalizeText(fullName);
	const reversed = [...tokens].reverse().join(' ');

	if (normalizedText.includes(full) || normalizedText.includes(reversed)) {
		return true;
	}

	const matchedTokens = tokens.filter(token => containsWholeWord(normalizedText, token));
	const firstName = tokens[0];
	const lastName = tokens[tokens.length - 1];
	const hasFirstName = containsWholeWord(normalizedText, firstName);
	const hasLastName = containsWholeWord(normalizedText, lastName);

	if (hasFirstName && hasLastName) {
		return true;
	}

	return matchedTokens.length >= Math.min(tokens.length, 3);
}

// ─── 1. Google News RSS ───────────────────────────────────────────────────────

async function crawlGoogleNews(name: string): Promise<WebHit[]> {
	const queries = [
		`"${name}" arnaque escroquerie fraude`,
		`"${name}" condamné tribunal mis en examen procès`,
		`"${name}" contrefaçon blanchiment corruption liquidation`,
	];

	const hits: WebHit[] = [];

	await Promise.allSettled(queries.map(async (q) => {
		try {
			const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=fr&gl=FR&ceid=FR:fr`;
			const res = await axios.get(url, {
				timeout: 8000,
				headers: { 'User-Agent': UA_BOT, Accept: 'application/rss+xml,application/xml,*/*' },
			});

			const $ = cheerio.load(res.data as string, { xmlMode: true });

			$('item').each((_, el) => {
				const title = cheerio.load($(el).find('title').text())('body').text().trim();
				const link = $(el).find('link').text().trim() || $(el).find('link').next().text().trim();
				const pubDate = $(el).find('pubDate').text().trim();
				const desc = cheerio.load($(el).find('description').text())('body').text();
				const kws = detectKeywords(`${title} ${desc}`);

				const mentionText = `${title} ${desc} ${link}`;

				if (title && kws.length > 0 && isRelevantPersonMention(name, mentionText)) {
					hits.push({
						source: 'Google News',
						title,
						url: link,
						snippet: desc.slice(0, 220),
						date: pubDate,
						keywords: kws,
						severity: assessSeverity(kws),
					});
				}
			});
		} catch {
			// échec silencieux par requête
		}
	}));

	return hits;
}

// ─── 2. BODACC — Annonces officielles FR ─────────────────────────────────────

async function crawlBODACC(nom: string, prenom: string): Promise<WebHit[]> {
	const hits: WebHit[] = [];
	const base = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets';

	// Procédures collectives (liquidation, redressement, sauvegarde)
	try {
		const res = await axios.get(`${base}/annonces-pcl/records`, {
			params: {
				where: `search(commercant, "${nom}") OR search(nom_dirigeant, "${nom}")`,
				limit: 10,
				order_by: 'dateparution desc',
			},
			timeout: 10000,
			headers: { 'User-Agent': UA_BOT, Accept: 'application/json' },
		});

		for (const r of (res.data?.results ?? [])) {
			const f = r.fields ?? r;
			const fullText = JSON.stringify(f).toLowerCase();
			if (!fullText.includes(nom.toLowerCase())) continue;

			const type = f.typeavis_lib ?? f.typeavis ?? 'procédure collective';
			const commercant = f.commercant ?? f.nom_dirigeant ?? '';
			const kws = ['liquidation judiciaire', 'redressement judiciaire', 'faillite', 'sauvegarde'].filter(k => fullText.includes(k));

			hits.push({
				source: 'BODACC',
				title: `${type} — ${commercant}`,
				url: `https://www.bodacc.fr/`,
				snippet: `Tribunal: ${f.tribunal ?? 'N/A'}. Publication: ${f.dateparution ?? 'N/A'}`,
				date: f.dateparution,
				keywords: kws.length ? kws : ['procédure collective'],
				severity: 'high',
			});
		}
	} catch {
		// silencieux
	}

	// Annonces commerciales — recherche par nom complet
	try {
		const res = await axios.get(`${base}/annonces-commerciales/records`, {
			params: { q: `${prenom} ${nom}`, limit: 5, order_by: 'dateparution desc' },
			timeout: 10000,
			headers: { 'User-Agent': UA_BOT },
		});

		for (const r of (res.data?.results ?? [])) {
			const f = r.fields ?? r;
			const text = JSON.stringify(f).toLowerCase();
			const kws = detectKeywords(text);
			if (!kws.length) continue;

			hits.push({
				source: 'BODACC Commerces',
				title: f.registreuniquetypeavis_lib ?? f.typeavis_lib ?? 'Annonce commerciale',
				url: 'https://www.bodacc.fr/',
				snippet: `${f.commercant ?? ''} — ${f.ville ?? ''} (${f.dateparution ?? ''})`,
				date: f.dateparution,
				keywords: kws,
				severity: assessSeverity(kws),
			});
		}
	} catch {
		// silencieux
	}

	return hits;
}

// ─── 3. Bing News ─────────────────────────────────────────────────────────────

async function crawlBingNews(name: string): Promise<WebHit[]> {
	const hits: WebHit[] = [];
	const negTerms = 'arnaque OR fraude OR escroquerie OR condamné OR tribunal OR contrefaçon OR liquidation OR corruption OR blanchiment';

	try {
		const res = await axios.get('https://www.bing.com/news/search', {
			params: { q: `"${name}" (${negTerms})`, mkt: 'fr-FR', count: 20, setlang: 'fr' },
			timeout: 10000,
			headers: {
				'User-Agent': UA_BROWSER,
				'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
				Accept: 'text/html,application/xhtml+xml',
				Referer: 'https://www.bing.com/',
			},
		});

		const $ = cheerio.load(res.data as string);

		// Bing News cards — sélecteurs multiples pour couvrir les variantes HTML
		$('div.news-card, div[class*="newsitem"], div[data-newsid], article').each((_, card) => {
			const $card = $(card);
			const title = $card.find('a.title, [class*="title"] a, h4 a').first().text().trim();
			const href = $card.find('a.title, [class*="title"] a, h4 a').first().attr('href') ?? '';
			const snippet = $card.find('[class*="snippet"], p').first().text().trim();
			const date = $card.find('[class*="time"], [class*="source"]').first().text().trim();
			const kws = detectKeywords(`${title} ${snippet}`);

			const mentionText = `${title} ${snippet} ${href}`;

			if (title && kws.length > 0 && isRelevantPersonMention(name, mentionText)) {
				hits.push({
					source: 'Bing News',
					title,
					url: href.startsWith('http') ? href : `https://www.bing.com${href}`,
					snippet: snippet.slice(0, 220),
					date,
					keywords: kws,
					severity: assessSeverity(kws),
				});
			}
		});
	} catch {
		// silencieux
	}

	return hits;
}

// ─── 4. Qwant News ────────────────────────────────────────────────────────────

async function crawlQwantNews(name: string): Promise<WebHit[]> {
	const hits: WebHit[] = [];

	// Requêtes courtes — Qwant retourne 0 résultats si trop de termes combinés
	const queries = [
		`"${name}" fraude`,
		`"${name}" tribunal condamné`,
		`"${name}" escroquerie arnaque`,
		`"${name}" corruption liquidation`,
	];

	await Promise.allSettled(queries.map(async (q) => {
		try {
			const res = await axios.get('https://api.qwant.com/v3/search/news', {
				params: { q, locale: 'fr_FR', count: 10, safesearch: 0 },
				timeout: 8000,
				headers: { 'User-Agent': UA_BROWSER, Accept: 'application/json' },
			});

			const items: any[] = res.data?.data?.result?.items ?? [];

			for (const item of items) {
				const title = item.title ?? '';
				const desc = item.desc ?? '';
				const kws = detectKeywords(`${title} ${desc}`);

				const mentionText = `${title} ${desc} ${item.url ?? ''}`;

				if (title && kws.length > 0 && isRelevantPersonMention(name, mentionText)) {
					hits.push({
						source: 'Qwant News',
						title,
						url: item.url ?? '',
						snippet: desc.slice(0, 220),
						date: item.date ? new Date(item.date * 1000).toISOString() : undefined,
						keywords: kws,
						severity: assessSeverity(kws),
					});
				}
			}
		} catch {
			// silencieux
		}
	}));

	return hits;
}

// ─── 5. Presse française ──────────────────────────────────────────────────────

interface PressSource {
	name: string;
	searchUrl: (name: string) => string;
	articleSel: string;
	titleSel: string;
	snippetSel: string;
	hrefBase: string;
}

const PRESS_SOURCES: PressSource[] = [
	{
		name: 'Le Figaro',
		searchUrl: (n) => `https://recherche.lefigaro.fr/recherche/?q=${encodeURIComponent(`"${n}"`)}`,
		articleSel: 'article, .fig-profile-article, [class*="fig-profile"]',
		titleSel: 'h2 a, h3 a, .fig-profile-article__title a, [class*="article-title"] a',
		snippetSel: 'p, [class*="chapo"], [class*="desc"]',
		hrefBase: 'https://www.lefigaro.fr',
	},
	{
		name: 'Actu.fr',
		searchUrl: (n) => `https://actu.fr/recherche/?q=${encodeURIComponent(`"${n}"`)}`,
		articleSel: 'article, [class*="card"], [class*="post"]',
		titleSel: 'h2 a, h3 a, [class*="title"] a',
		snippetSel: 'p, [class*="summary"], [class*="excerpt"]',
		hrefBase: 'https://actu.fr',
	},
];

async function crawlFrenchPress(name: string): Promise<WebHit[]> {
	const hits: WebHit[] = [];

	await Promise.allSettled(PRESS_SOURCES.map(async (src) => {
		try {
			const res = await axios.get(src.searchUrl(name), {
				timeout: 9000,
				headers: { 'User-Agent': UA_BROWSER, 'Accept-Language': 'fr-FR,fr;q=0.9' },
			});

			const $ = cheerio.load(res.data as string);

			$(src.articleSel).slice(0, 15).each((_, el) => {
				const $el = $(el);
				const title = $el.find(src.titleSel).first().text().trim();
				const href = $el.find(src.titleSel).first().attr('href') ?? '';
				const snip = $el.find(src.snippetSel).first().text().trim();
				const kws = detectKeywords(`${title} ${snip}`);

				const mentionText = `${title} ${snip} ${href}`;

				if (title && kws.length > 0 && isRelevantPersonMention(name, mentionText)) {
					hits.push({
						source: src.name,
						title,
						url: href.startsWith('http') ? href : `${src.hrefBase}${href}`,
						snippet: snip.slice(0, 220),
						keywords: kws,
						severity: assessSeverity(kws),
					});
				}
			});
		} catch {
			// échec silencieux par source
		}
	}));

	return hits;
}

// ─── 6. Pappers.fr (optionnel — nécessite PAPPERS_API_KEY) ───────────────────

async function crawlPappers(nom: string, prenom: string): Promise<WebHit[]> {
	const apiKey = process.env.PAPPERS_API_KEY;
	if (!apiKey) return [];

	try {
		const res = await axios.get('https://api.pappers.fr/v2/recherche-dirigeants', {
			params: { q: `${prenom} ${nom}`, api_token: apiKey, bases: 'dirigeants', hits_par_page: 5 },
			timeout: 8000,
			headers: { 'User-Agent': UA_BOT },
		});

		const hits: WebHit[] = [];

		for (const dirigeant of (res.data?.resultats ?? [])) {
			for (const c of (dirigeant.entreprises ?? [])) {
				const statut = (c.statut_rcs ?? '').toLowerCase();
				if (!statut.includes('liquidation') && !statut.includes('cessation') && !statut.includes('dissolution')) continue;

				const kws = detectKeywords(statut);
				hits.push({
					source: 'Pappers.fr',
					title: `${c.denomination ?? ''} — ${c.statut_rcs ?? ''}`,
					url: `https://www.pappers.fr/entreprise/${c.siren ?? ''}`,
					snippet: `SIREN: ${c.siren ?? ''}. Statut: ${c.statut_rcs ?? ''}. Forme juridique: ${c.forme_juridique ?? ''}`,
					keywords: kws.length ? kws : ['liquidation judiciaire'],
					severity: 'high',
				});
			}
		}

		return hits;
	} catch {
		return [];
	}
}

// ─── Déduplication ────────────────────────────────────────────────────────────

function dedup(hits: WebHit[]): WebHit[] {
	const seen = new Set<string>();
	return hits.filter(h => {
		const key = h.url || `${h.source}::${h.title}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// ─── Agrégateur principal ─────────────────────────────────────────────────────

export async function checkWebReputation(input: IdentityInput): Promise<VerificationResult> {
	const fullName = `${input.prenom} ${input.nom}`.trim();

	const base: Omit<VerificationResult, 'status' | 'summary' | 'details' | 'matches'> = {
		id: 'web_reputation',
		source: 'Web Crawling',
		sourceLabel: 'Réputation web (multi-sources)',
		category: 'reputation',
		confidence: 0.70,
		url: `https://news.google.com/rss/search?q=${encodeURIComponent(`"${fullName}"`)}`,
		checkedAt: new Date(),
	};

	try {
		const [googleNews, bodacc, bingNews, qwantNews, frenchPress, pappers] = await Promise.allSettled([
			crawlGoogleNews(fullName),
			crawlBODACC(input.nom, input.prenom),
			crawlBingNews(fullName),
			crawlQwantNews(fullName),
			crawlFrenchPress(fullName),
			crawlPappers(input.nom, input.prenom),
		]);

		const allHits = dedup([
			...(googleNews.status === 'fulfilled' ? googleNews.value : []),
			...(bodacc.status === 'fulfilled' ? bodacc.value : []),
			...(bingNews.status === 'fulfilled' ? bingNews.value : []),
			...(qwantNews.status === 'fulfilled' ? qwantNews.value : []),
			...(frenchPress.status === 'fulfilled' ? frenchPress.value : []),
			...(pappers.status === 'fulfilled' ? pappers.value : []),
		]);

		if (allHits.length === 0) {
			const sourcesChecked = [
				googleNews.status === 'fulfilled' ? 'Google News' : null,
				bodacc.status === 'fulfilled' ? 'BODACC' : null,
				bingNews.status === 'fulfilled' ? 'Bing News' : null,
				qwantNews.status === 'fulfilled' ? 'Qwant News' : null,
				frenchPress.status === 'fulfilled' ? 'Presse FR' : null,
			].filter(Boolean).join(', ');

			return {
				...base,
				status: 'clear',
				summary: 'Aucune exposition négative détectée',
				details: `Aucun résultat préoccupant sur: ${sourcesChecked}.`,
				matches: [],
			};
		}

		// Trier par sévérité
		const order = { critical: 0, high: 1, medium: 2, low: 3 };
		allHits.sort((a, b) => order[a.severity] - order[b.severity]);

		const critical = allHits.filter(h => h.severity === 'critical');
		const high = allHits.filter(h => h.severity === 'high');

		const topStatus: VerificationStatus = (critical.length > 0 || high.length > 0) ? 'alert' : 'warning';
		const topHits = allHits.slice(0, 5);
		const sources = [...new Set(allHits.map(h => h.source))].join(', ');

		logSystemEvent({
			action: 'ocr_progress',
			component: 'webReputation',
			details: { total: allHits.length, critical: critical.length, high: high.length, sources },
			severity: 'info',
		});

		return {
			...base,
			status: topStatus,
			summary: `${allHits.length} résultat(s) — ${critical.length} critique(s), ${high.length} élevé(s) sur ${[...new Set(allHits.map(h => h.source))].length} source(s)`,
			details: topHits
				.map(h => `[${h.source}] ${h.title} · mots-clés: ${h.keywords.slice(0, 4).join(', ')}`)
				.join('\n'),
			matches: allHits,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logSystemEvent({ action: 'ocr_error', component: 'webReputation', details: { error: msg }, severity: 'warning' });
		return { ...base, status: 'error', summary: 'Service indisponible', details: `Web Crawling: ${msg}`, matches: [] };
	}
}
