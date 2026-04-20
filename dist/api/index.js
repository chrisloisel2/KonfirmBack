"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = __importDefault(require("./routes/auth"));
const dossiers_1 = __importDefault(require("./routes/dossiers"));
const documents_1 = __importDefault(require("./routes/documents"));
const recherches_1 = __importDefault(require("./routes/recherches"));
const scoring_1 = __importDefault(require("./routes/scoring"));
const exceptions_1 = __importDefault(require("./routes/exceptions"));
const verification_1 = __importDefault(require("./routes/verification"));
const dashboard_1 = __importDefault(require("./routes/dashboard"));
const search_1 = __importDefault(require("./routes/search"));
const watchlists_1 = __importDefault(require("./routes/watchlists"));
const intelligence_1 = __importDefault(require("./routes/intelligence"));
const auth_2 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Route de santé publique (sans authentification)
router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'API Konfirm LCB-FT - Service opérationnel',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});
// Routes d'authentification (publiques)
router.use('/auth', auth_1.default);
// Toutes les autres routes nécessitent une authentification
const auth = auth_2.authenticateToken;
router.use('/dossiers', auth, dossiers_1.default);
router.use('/documents', auth, documents_1.default);
router.use('/recherches', auth, recherches_1.default);
router.use('/scoring', auth, scoring_1.default);
router.use('/exceptions', auth, exceptions_1.default);
router.use('/verification', auth, verification_1.default);
router.use('/dashboard', auth, dashboard_1.default);
router.use('/search', search_1.default);
router.use('/watchlists', watchlists_1.default);
router.use('/intelligence', intelligence_1.default);
// Route de test d'authentification
router.get('/protected-test', auth_2.authenticateToken, (req, res) => {
    const user = req.user;
    res.json({
        success: true,
        message: 'Accès autorisé',
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            firstName: user.firstName,
            lastName: user.lastName
        },
        timestamp: new Date().toISOString()
    });
});
// Gestion des routes non trouvées
router.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: {
            message: 'Route API non trouvée',
            path: req.originalUrl,
            method: req.method,
            timestamp: new Date().toISOString()
        }
    });
});
exports.default = router;
//# sourceMappingURL=index.js.map