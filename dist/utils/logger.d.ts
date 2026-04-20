import winston from 'winston';
declare const logger: winston.Logger;
/**
 * Log événement d'authentification (succès/échec)
 */
export declare function logAuthEvent(event: {
    action: 'login' | 'logout' | 'failed_login' | 'account_locked' | 'login_failed' | 'login_success';
    userId?: string;
    email?: string;
    ip?: string;
    ipAddress?: string;
    userAgent?: string;
    success?: boolean;
    reason?: string;
}): void;
/**
 * Log événement dossier LCB-FT
 */
export declare function logDossierEvent(event: {
    action: 'create' | 'update' | 'validate' | 'escalate' | 'block' | 'archive' | 'client_created' | 'client_updated' | 'dossier_created' | 'dossier_updated' | 'dossier_assigned' | 'document_uploaded' | 'document_verified' | 'document_unverified' | 'document_ocr_reprocessed' | 'suspicion_evaluated' | 'tracfin_declaration_generated' | 'tracfin_declaration_transmitted' | 'tracfin_history_accessed';
    dossierId: string;
    userId: string;
    clientType?: string;
    amount?: number;
    status?: string;
    details?: any;
}): void;
/**
 * Log recherche PPE/sanctions/gels
 */
export declare function logResearchEvent(event: {
    action: 'search' | 'result' | 'cache_hit' | 'ppe_match_detected' | 'ppe_search_completed' | 'sanctions_match_detected' | 'sanctions_search_completed' | 'asset_freeze_match_detected' | 'asset_freeze_search_completed' | 'complete_search_finished';
    searchType?: string;
    rechercheId?: string;
    dossierId?: string;
    userId?: string;
    query?: string;
    source?: string;
    results?: number;
    hasAlerts?: boolean;
    details?: any;
}): void;
/**
 * Log événement scoring et décision automatique
 */
export declare function logScoringEvent(event: {
    action: 'calculate' | 'decision' | 'override' | 'scoring_calculated';
    dossierId?: string;
    userId?: string;
    scores?: any;
    finalScore?: number;
    decision?: string;
    isAutomatic?: boolean;
    justification?: string;
    details?: any;
}): void;
/**
 * Log exception et validation humaine
 */
export declare function logExceptionEvent(event: {
    action: 'create' | 'validate' | 'escalate' | 'resolve' | 'exception_created' | 'exception_updated' | 'exception_assigned';
    exceptionType?: string;
    exceptionId?: string;
    dossierId?: string;
    userId?: string;
    validatorRole?: string;
    decision?: string;
    justification?: string;
    details?: any;
}): void;
/**
 * Log événements système critiques
 */
export declare function logSystemEvent(event: {
    action: 'startup' | 'shutdown' | 'backup' | 'migration' | 'security_alert' | 'ocr_start' | 'ocr_done' | 'ocr_failed' | 'ocr_progress' | 'ocr_error' | 'file_cleanup_error' | 'document_upload_error' | 'external_api_request' | 'external_api_response' | 'external_api_error' | 'lcb_ft_verification_start' | 'lcb_ft_verification_complete' | 'tracfin_declaration_generated' | 'ermes_transmission_start' | 'ermes_transmission_success' | 'ermes_transmission_error' | 'declaration_history_request' | 'search_history_error' | 'osint_mega_start' | 'osint_mega_complete' | 'intelligence_report_start' | 'intelligence_report_complete' | 'intelligence_report_save_error' | 'watchlist_check_error' | 'watchlist_batch_check_start' | 'watchlist_batch_check_error' | 'watchlist_batch_check_complete' | 'batch_search_start' | 'batch_search_complete' | string;
    component?: string;
    details?: any;
    severity: 'info' | 'warning' | 'warn' | 'error' | 'critical';
}): void;
export declare function logSecurityEvent(event: {
    userId?: string;
    action: string;
    details?: any;
    ipAddress?: string;
    severity: 'info' | 'warning' | 'error' | 'critical';
}): void;
export declare function logAuditEvent(event: {
    userId?: string;
    action: string;
    resource?: string;
    resourceId?: string;
    oldValues?: any;
    newValues?: any;
    ipAddress?: string;
    metadata?: any;
    details?: any;
}): void;
export declare const logRechercheEvent: typeof logResearchEvent;
export default logger;
//# sourceMappingURL=logger.d.ts.map