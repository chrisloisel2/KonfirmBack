import { Request, Response, NextFunction } from 'express';
export interface CustomError extends Error {
    statusCode?: number;
    isOperational?: boolean;
    code?: string;
    details?: any;
}
declare class AppError extends Error {
    statusCode: number;
    isOperational: boolean;
    code: string;
    details?: any;
    constructor(message: string, statusCode: number, code?: string, details?: any);
}
export declare class ValidationError extends AppError {
    constructor(message: string, details?: any);
}
export declare class AuthenticationError extends AppError {
    constructor(message?: string, details?: any);
}
export declare class AuthorizationError extends AppError {
    constructor(message?: string, details?: any);
}
export declare class ComplianceError extends AppError {
    constructor(message: string, details?: any);
}
export declare class ExternalServiceError extends AppError {
    constructor(service: string, message: string, details?: any);
}
declare const errorHandler: (error: CustomError, req: Request, res: Response, next: NextFunction) => void;
export declare const asyncHandler: (fn: Function) => (req: Request, res: Response, next: NextFunction) => void;
export declare const unhandledErrorHandler: () => void;
export { AppError, errorHandler };
export default errorHandler;
//# sourceMappingURL=errorHandler.d.ts.map