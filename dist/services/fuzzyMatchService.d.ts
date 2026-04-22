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
    score: number;
    levenshtein: number;
    jaroWinkler: number;
    soundexMatch: boolean;
    metaphoneMatch: boolean;
    ngramSimilarity: number;
    nameTokenMatch: number;
    isMatch: boolean;
    matchType: 'EXACT' | 'STRONG' | 'PROBABLE' | 'POSSIBLE' | 'WEAK' | 'NO_MATCH';
}
export declare function normalize(s: string): string;
export declare function computeFuzzyMatch(query: string, candidate: string, threshold?: number): FuzzyMatchResult;
export interface ScreeningResult {
    candidate: string;
    match: FuzzyMatchResult;
    originalIndex: number;
}
export declare function screenNameAgainstList(query: string, list: string[], threshold?: number): ScreeningResult[];
export declare function matchFullName(queryFirst: string, queryLast: string, candidateFirst: string, candidateLast: string, threshold?: number): FuzzyMatchResult & {
    firstNameMatch: FuzzyMatchResult;
    lastNameMatch: FuzzyMatchResult;
};
export declare function matchDateOfBirth(queryDob: string | undefined, candidateDob: string | undefined): {
    match: boolean;
    confidence: number;
    note?: string;
};
//# sourceMappingURL=fuzzyMatchService.d.ts.map