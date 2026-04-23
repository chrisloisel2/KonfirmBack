import { Router } from 'express';
import authRoutes from './routes/auth';
import dossierRoutes from './routes/dossiers';
import documentRoutes from './routes/documents';
import rechercheRoutes from './routes/recherches';
import scoringRoutes from './routes/scoring';
import exceptionRoutes from './routes/exceptions';
import verificationRoutes from './routes/verification';
import dashboardRoutes from './routes/dashboard';
import searchRoutes from './routes/search';
import watchlistRoutes from './routes/watchlists';
import intelligenceRoutes from './routes/intelligence';
import settingsRoutes from './routes/settings';
import archivageRoutes from './routes/archivage';
import adminRoutes from './routes/admin';
import { authenticateToken } from '../middleware/auth';

const router = Router();

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
router.use('/auth', authRoutes);

// Toutes les autres routes nécessitent une authentification
const auth = authenticateToken as any;
router.use('/dossiers', auth, dossierRoutes);
router.use('/documents', auth, documentRoutes);
router.use('/recherches', auth, rechercheRoutes);
router.use('/scoring', auth, scoringRoutes);
router.use('/exceptions', auth, exceptionRoutes);
router.use('/verification', auth, verificationRoutes);
router.use('/dashboard', auth, dashboardRoutes);
router.use('/search', searchRoutes);
router.use('/watchlists', watchlistRoutes);
router.use('/intelligence', intelligenceRoutes);
router.use('/settings', auth, settingsRoutes);
router.use('/archivage', auth, archivageRoutes);
router.use('/admin', auth, adminRoutes);

// Route de test d'authentification
router.get('/protected-test', authenticateToken, (req, res) => {
	const user = (req as any).user;
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

export default router;
