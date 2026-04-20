/**
 * Setup intégration tests - Configuration API et base de données
 */

import { jest } from '@jest/globals';

beforeAll(async () => {
	// Configuration spécifique tests d'intégration
	console.log('🔧 Configuration tests d\'intégration LCB-FT...');

	// Mock Express app pour tests API
	jest.doMock('../../src/app', () => {
		const express = require('express');
		const app = express();

		app.use(express.json());

		// Mock middleware d'authentification
		app.use('/api', (req: any, res: any, next: any) => {
			if (req.headers.authorization === 'Bearer valid-token') {
				req.user = {
					id: 'user-conseiller-1',
					role: 'CONSEILLER',
					email: 'test@godechot-pauliet.fr'
				};
			}
			next();
		});

		// Import routes mockées
		const routes = require('../../src/api/routes');
		app.use('/api', routes);

		return app;
	});
});

afterAll(async () => {
	console.log('✅ Nettoyage tests d\'intégration terminé');
});
