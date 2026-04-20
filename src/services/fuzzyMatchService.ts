/**
 * Fuzzy & Phonetic Matching Engine
 *
 * Algorithms:
 *   - Levenshtein distance (edit distance)
 *   - Jaro-Winkler similarity
 *   - Soundex (anglophone)
 *   - Soundex français (adapté pour préfixes/accents FR)
 *   - Metaphone (phonétique anglaise)
 *   - Metaphone français (adapté: ch→sh, gn→ny, ph→f, etc.)
 *   - N-gram similarity (trigramme)
 *   - Tokenized name matching (prénom + nom indépendants)
 *   - Score composite pondéré
 */

export interface FuzzyMatchResult {
	score: number;             // 0–1 composite score
	levenshtein: number;       // 0–1
	jaroWinkler: number;       // 0–1
	soundexMatch: boolean;
	metaphoneMatch: boolean;
	ngramSimilarity: number;   // 0–1
	nameTokenMatch: number;    // 0–1 (match partiel prénom/nom)
	isMatch: boolean;          // score >= threshold
	matchType: 'EXACT' | 'STRONG' | 'PROBABLE' | 'POSSIBLE' | 'WEAK' | 'NO_MATCH';
}

// ─── Levenshtein distance ────────────────────────────────────────────────────

function levenshteinDistance(a: string, b: string): number {
	const m = a.length, n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;

	const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
	for (let j = 0; j <= n; j++) dp[0][j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1]
				? dp[i - 1][j - 1]
				: 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}
	return dp[m][n];
}

function levenshteinSimilarity(a: string, b: string): number {
	const dist = levenshteinDistance(a, b);
	const maxLen = Math.max(a.length, b.length);
	return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

// ─── Jaro-Winkler similarity ─────────────────────────────────────────────────

function jaroSimilarity(s1: string, s2: string): number {
	if (s1 === s2) return 1;
	const len1 = s1.length, len2 = s2.length;
	if (len1 === 0 || len2 === 0) return 0;

	const matchDist = Math.floor(Math.max(len1, len2) / 2) - 1;
	const s1Matches = new Array(len1).fill(false);
	const s2Matches = new Array(len2).fill(false);
	let matches = 0, transpositions = 0;

	for (let i = 0; i < len1; i++) {
		const start = Math.max(0, i - matchDist);
		const end = Math.min(i + matchDist + 1, len2);
		for (let j = start; j < end; j++) {
			if (s2Matches[j] || s1[i] !== s2[j]) continue;
			s1Matches[i] = true;
			s2Matches[j] = true;
			matches++;
			break;
		}
	}
	if (matches === 0) return 0;

	let k = 0;
	for (let i = 0; i < len1; i++) {
		if (!s1Matches[i]) continue;
		while (!s2Matches[k]) k++;
		if (s1[i] !== s2[k]) transpositions++;
		k++;
	}
	return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
}

function jaroWinklerSimilarity(s1: string, s2: string, p = 0.1): number {
	const jaro = jaroSimilarity(s1, s2);
	let prefixLen = 0;
	const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
	while (prefixLen < maxPrefix && s1[prefixLen] === s2[prefixLen]) prefixLen++;
	return jaro + prefixLen * p * (1 - jaro);
}

// ─── Soundex (standard + français) ──────────────────────────────────────────

const SOUNDEX_MAP: Record<string, string> = {
	b: '1', f: '1', p: '1', v: '1',
	c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
	d: '3', t: '3',
	l: '4',
	m: '5', n: '5',
	r: '6'
};

function soundex(name: string): string {
	const s = normalize(name).replace(/[^a-z]/g, '');
	if (!s) return '0000';

	let code = s[0].toUpperCase();
	let prev = SOUNDEX_MAP[s[0]] || '0';

	for (let i = 1; i < s.length && code.length < 4; i++) {
		const curr = SOUNDEX_MAP[s[i]] || '0';
		if (curr !== '0' && curr !== prev) {
			code += curr;
		}
		prev = curr;
	}
	return code.padEnd(4, '0');
}

// ─── Metaphone français ──────────────────────────────────────────────────────

function metaphoneFR(name: string): string {
	let s = normalize(name).replace(/[^a-z]/g, '');
	if (!s) return '';

	// French phonetic transformations
	s = s
		.replace(/ph/g, 'f')
		.replace(/ch/g, 'x')
		.replace(/gn/g, 'ny')
		.replace(/qu/g, 'k')
		.replace(/gu([ei])/g, 'g$1')
		.replace(/ge/g, 'je')
		.replace(/gi/g, 'ji')
		.replace(/ç/g, 's')
		.replace(/eau/g, 'o')
		.replace(/aux/g, 'o')
		.replace(/eu/g, 'e')
		.replace(/ou/g, 'u')
		.replace(/oi/g, 'oa')
		.replace(/ille/g, 'iy')
		.replace(/[aeiou]s[aeiou]/g, (m) => m[0] + 'z' + m[2])
		.replace(/ss/g, 's')
		.replace(/([^a-z]|^)h/g, '$1')
		.replace(/[aeiou]+/g, (m) => m[0]);

	// Remove trailing silent consonants in French
	s = s.replace(/[tdspxz]$/, '');

	return s.toUpperCase().substring(0, 6);
}

// ─── N-gram similarity ───────────────────────────────────────────────────────

function ngrams(s: string, n = 3): Set<string> {
	const padded = `${'_'.repeat(n - 1)}${s}${'_'.repeat(n - 1)}`;
	const result = new Set<string>();
	for (let i = 0; i <= padded.length - n; i++) {
		result.add(padded.substring(i, i + n));
	}
	return result;
}

function ngramSimilarity(a: string, b: string, n = 3): number {
	if (a === b) return 1;
	if (a.length < n || b.length < n) return a === b ? 1 : 0;

	const ngramsA = ngrams(a, n);
	const ngramsB = ngrams(b, n);
	let intersection = 0;

	for (const gram of ngramsA) {
		if (ngramsB.has(gram)) intersection++;
	}
	return (2 * intersection) / (ngramsA.size + ngramsB.size);
}

// ─── Normalisation ───────────────────────────────────────────────────────────

const ACCENT_MAP: Record<string, string> = {
	à: 'a', â: 'a', ä: 'a', á: 'a', ã: 'a',
	è: 'e', é: 'e', ê: 'e', ë: 'e',
	î: 'i', ï: 'i', í: 'i', ì: 'i',
	ô: 'o', ö: 'o', ó: 'o', ò: 'o', õ: 'o',
	ù: 'u', û: 'u', ü: 'u', ú: 'u',
	ç: 'c', ñ: 'n', ý: 'y', ÿ: 'y',
	// Arabic/North African transliteration
	'-': '', "'": '', ' ': '', '.': '',
};

export function normalize(s: string): string {
	return s
		.toLowerCase()
		.split('')
		.map(c => ACCENT_MAP[c] ?? c)
		.join('')
		.replace(/[^a-z0-9]/g, '');
}

// ─── Name tokenizer (prénom + nom séparés) ──────────────────────────────────

function tokenizedNameMatch(query: string, candidate: string): number {
	const qTokens = query.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
	const cTokens = candidate.toLowerCase().split(/[\s\-_]+/).filter(Boolean);

	if (qTokens.length === 0 || cTokens.length === 0) return 0;

	let totalScore = 0;
	let matchCount = 0;

	for (const qt of qTokens) {
		let bestScore = 0;
		for (const ct of cTokens) {
			const score = jaroWinklerSimilarity(normalize(qt), normalize(ct));
			if (score > bestScore) bestScore = score;
		}
		totalScore += bestScore;
		if (bestScore > 0.8) matchCount++;
	}

	return totalScore / qTokens.length;
}

// ─── Composite scorer ────────────────────────────────────────────────────────

export function computeFuzzyMatch(
	query: string,
	candidate: string,
	threshold = 0.72
): FuzzyMatchResult {
	const qNorm = normalize(query);
	const cNorm = normalize(candidate);

	// Exact match fast-path
	if (qNorm === cNorm) {
		return {
			score: 1,
			levenshtein: 1,
			jaroWinkler: 1,
			soundexMatch: true,
			metaphoneMatch: true,
			ngramSimilarity: 1,
			nameTokenMatch: 1,
			isMatch: true,
			matchType: 'EXACT'
		};
	}

	const lev = levenshteinSimilarity(qNorm, cNorm);
	const jw = jaroWinklerSimilarity(qNorm, cNorm);
	const ngram = ngramSimilarity(qNorm, cNorm);
	const tokenMatch = tokenizedNameMatch(query, candidate);
	const soundexMatch = soundex(query) === soundex(candidate);
	const metaphoneMatch = metaphoneFR(query) === metaphoneFR(candidate);

	// Weighted composite: prioritise Jaro-Winkler + token match for names
	const score =
		jw * 0.35 +
		lev * 0.20 +
		ngram * 0.20 +
		tokenMatch * 0.15 +
		(soundexMatch ? 0.05 : 0) +
		(metaphoneMatch ? 0.05 : 0);

	const matchType =
		score >= 0.97 ? 'EXACT' :
		score >= 0.88 ? 'STRONG' :
		score >= 0.80 ? 'PROBABLE' :
		score >= 0.70 ? 'POSSIBLE' :
		score >= 0.55 ? 'WEAK' :
		'NO_MATCH';

	return {
		score,
		levenshtein: lev,
		jaroWinkler: jw,
		soundexMatch,
		metaphoneMatch,
		ngramSimilarity: ngram,
		nameTokenMatch: tokenMatch,
		isMatch: score >= threshold,
		matchType
	};
}

// ─── Batch name screening ────────────────────────────────────────────────────

export interface ScreeningResult {
	candidate: string;
	match: FuzzyMatchResult;
	originalIndex: number;
}

export function screenNameAgainstList(
	query: string,
	list: string[],
	threshold = 0.72
): ScreeningResult[] {
	return list
		.map((candidate, idx) => ({
			candidate,
			match: computeFuzzyMatch(query, candidate, threshold),
			originalIndex: idx
		}))
		.filter(r => r.match.isMatch)
		.sort((a, b) => b.match.score - a.match.score);
}

// ─── Full-name composite (prénom + nom) ─────────────────────────────────────

export function matchFullName(
	queryFirst: string,
	queryLast: string,
	candidateFirst: string,
	candidateLast: string,
	threshold = 0.72
): FuzzyMatchResult & { firstNameMatch: FuzzyMatchResult; lastNameMatch: FuzzyMatchResult } {
	const firstMatch = computeFuzzyMatch(queryFirst, candidateFirst, threshold);
	const lastMatch = computeFuzzyMatch(queryLast, candidateLast, threshold);

	// Also try reversed (prénom ↔ nom swap — common in Arab/Asian naming)
	const reversedFirst = computeFuzzyMatch(queryFirst, candidateLast, threshold);
	const reversedLast = computeFuzzyMatch(queryLast, candidateFirst, threshold);

	const normalScore = (firstMatch.score + lastMatch.score) / 2;
	const reversedScore = (reversedFirst.score + reversedLast.score) / 2;
	const bestScore = Math.max(normalScore, reversedScore);

	const composite = computeFuzzyMatch(
		`${queryFirst} ${queryLast}`,
		`${candidateFirst} ${candidateLast}`,
		threshold
	);
	composite.score = Math.max(composite.score, bestScore);
	composite.isMatch = composite.score >= threshold;

	const matchType =
		composite.score >= 0.97 ? 'EXACT' :
		composite.score >= 0.88 ? 'STRONG' :
		composite.score >= 0.80 ? 'PROBABLE' :
		composite.score >= 0.70 ? 'POSSIBLE' :
		composite.score >= 0.55 ? 'WEAK' :
		'NO_MATCH';

	composite.matchType = matchType;

	return { ...composite, firstNameMatch: firstMatch, lastNameMatch: lastMatch };
}

// ─── Date de naissance fuzzy ─────────────────────────────────────────────────

export function matchDateOfBirth(
	queryDob: string | undefined,
	candidateDob: string | undefined
): { match: boolean; confidence: number; note?: string } {
	if (!queryDob || !candidateDob) return { match: false, confidence: 0 };

	const normalize = (d: string) => d.replace(/[\-\/\.]/g, '').trim();
	const qn = normalize(queryDob);
	const cn = normalize(candidateDob);

	if (qn === cn) return { match: true, confidence: 1.0 };

	// Year match only
	const qYear = queryDob.match(/\d{4}/)?.[0];
	const cYear = candidateDob.match(/\d{4}/)?.[0];
	if (qYear && cYear && qYear === cYear) {
		return { match: true, confidence: 0.6, note: 'année seulement' };
	}

	// Off by 1 day (transposition fréquente)
	if (qn.length === 8 && cn.length === 8 && qn.substring(0, 6) === cn.substring(0, 6)) {
		const diff = Math.abs(parseInt(qn.slice(6)) - parseInt(cn.slice(6)));
		if (diff <= 1) return { match: true, confidence: 0.85, note: '±1 jour' };
	}

	return { match: false, confidence: 0 };
}
