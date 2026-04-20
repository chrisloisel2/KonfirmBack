import { Request, Response, NextFunction } from 'express';
declare global {
    namespace Express {
        interface User {
            id: string;
            email: string;
            role: string;
            firstName: string;
            lastName: string;
        }
    }
}
interface AuthenticatedRequest extends Request {
    user?: Express.User;
}
export declare const authenticateToken: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>;
export declare const requireRole: (...roles: string[]) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const requireMinimumRole: (minimumRole: string) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const requireSelfOrRole: (allowedRoles: string[]) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export declare const requireDossierAccess: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>;
export declare const requireDataValidation: (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
export { AuthenticatedRequest };
//# sourceMappingURL=auth.d.ts.map