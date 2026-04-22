/**
 * Intelligence Service — Rapports de Renseignement Complets
 *
 * Génère un rapport d'intelligence exhaustif combinant:
 *   - Toutes les sources OSINT (25+)
 *   - Données internes (dossiers, exceptions, scoring, TRACFIN)
 *   - Analyse des connexions et réseaux
 *   - Profil de risque synthétisé
 *   - Timeline des événements significatifs
 *   - Recommandations conformité
 *   - Indicateurs comportementaux
 *   - Indice d'exposition politique (PEP)
 *   - Score de vigilance renforcée
 */
import { OsintReport } from './osintMegaService';
import { TimelineEvent } from './universalSearchService';
export interface IntelligenceReportInput {
    nom: string;
    prenom?: string;
    dateNaissance?: string;
    nationalite?: string;
    pays?: string;
    entreprise?: string;
    siret?: string;
    subjectType: 'PERSON' | 'COMPANY' | 'MIXED';
    clientId?: string;
    dossierId?: string;
    requestedBy: string;
}
export interface IntelligenceReportOutput {
    id?: string;
    subject: {
        nom: string;
        prenom?: string;
        fullName: string;
        type: string;
        dateNaissance?: string;
        nationalite?: string;
        pays?: string;
        entreprise?: string;
    };
    executiveSummary: {
        overallRisk: string;
        riskScore: number;
        pepScore: number;
        sanctionsExposure: boolean;
        assetFreezeExposure: boolean;
        judicialRecord: boolean;
        negativePress: boolean;
        keyAlerts: string[];
        recommendation: string;
        vigilanceLevel: 'SIMPLIFIEE' | 'STANDARD' | 'RENFORCEE' | 'REFUS_RECOMMANDE';
    };
    sections: {
        identite: IdentiteSection;
        sanctionsEtGel: SanctionsSection;
        ppe: PPESection;
        judiciaire: JudiciaireSection;
        entreprises: EntreprisesSection;
        repuationPresse: PressSection;
        risquePays: RisquesPaysSection;
        interne: InterneSection;
        reseauConnexions: ReseauSection;
        timeline: TimelineSection;
        scoring: ScoringSection;
    };
    osintReport: OsintReport;
    generatedAt: Date;
    expiresAt: Date;
    durationMs: number;
    requestedBy: string;
}
interface IdentiteSection {
    status: 'VERIFIED' | 'UNVERIFIED' | 'INCONSISTENCIES';
    documents: any[];
    aliases: string[];
    birthDetails: any;
    addresses: string[];
    contacts: string[];
    notes: string[];
}
interface SanctionsSection {
    hasSanctions: boolean;
    hasAssetFreeze: boolean;
    matches: any[];
    sources: string[];
    lastChecked: Date;
    notes: string[];
}
interface PPESection {
    isPPE: boolean;
    pepScore: number;
    politicalFunctions: string[];
    familyConnections: string[];
    sources: string[];
    notes: string[];
}
interface JudiciaireSection {
    hasRecord: boolean;
    decisions: any[];
    sources: string[];
    notes: string[];
}
interface EntreprisesSection {
    companies: any[];
    totalCompanies: number;
    dissolutions: number;
    suspiciousStructures: string[];
    beneficialOwnership: any[];
    notes: string[];
}
interface PressSection {
    articles: any[];
    sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'VERY_NEGATIVE';
    negativeKeywords: string[];
    sources: string[];
    notes: string[];
}
interface RisquesPaysSection {
    flaggedCountries: string[];
    fatfStatus: string[];
    corruptionIndex: any[];
    notes: string[];
}
interface InterneSection {
    hasDossiers: boolean;
    dossierCount: number;
    dossiers: any[];
    totalExceptions: number;
    criticalExceptions: number;
    hasTracfin: boolean;
    tracfinCount: number;
    maxRiskScore: number;
    riskHistory: any[];
    notes: string[];
}
interface ReseauSection {
    connectedPersons: string[];
    connectedCompanies: string[];
    sharedAddresses: string[];
    suspiciousLinks: string[];
    notes: string[];
}
interface TimelineSection {
    events: TimelineEvent[];
    firstActivity?: Date;
    lastActivity?: Date;
    totalEvents: number;
}
interface ScoringSection {
    latestScore?: number;
    latestLevel?: string;
    scoreHistory: any[];
    riskFactors: string[];
    recommendation: string;
}
export declare function generateIntelligenceReport(input: IntelligenceReportInput): Promise<IntelligenceReportOutput>;
export declare function getUserReports(userId: string): Promise<any>;
export declare function getReport(reportId: string, userId: string): Promise<any>;
export {};
//# sourceMappingURL=intelligenceService.d.ts.map