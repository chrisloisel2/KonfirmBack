export interface IdentityData {
    nom: string;
    prenom: string;
    dateNaissance: string;
    nationalite: string;
    numeroDocument: string;
    dateExpiration: string;
    sexe?: string;
    lieuNaissance?: string;
    confidence: number;
    source: 'mindee' | 'tesseract_mrz' | 'tesseract_text';
    mrzValid?: boolean;
    raw?: any;
}
export declare function extractIdentityData(imagePath: string, docType?: 'cni' | 'passeport'): Promise<IdentityData>;
//# sourceMappingURL=ocrService.d.ts.map