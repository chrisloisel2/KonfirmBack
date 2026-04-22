/**
 * Configuration globale des tests LCB-FT
 *
 * Setup Jest pour environnement de test unifié
 */

import { jest } from '@jest/globals';

const mockPrisma = {
	$connect: jest.fn(),
	$disconnect: jest.fn(),
	user: {
		findUnique: jest.fn(),
		create: jest.fn(),
		update: jest.fn(),
		delete: jest.fn()
	},
	dossier: {
		findUnique: jest.fn(),
		findMany: jest.fn(),
		create: jest.fn(),
		update: jest.fn(),
		delete: jest.fn()
	},
	tracfinDeclaration: {
		findUnique: jest.fn(),
		findMany: jest.fn(),
		create: jest.fn(),
		update: jest.fn(),
		delete: jest.fn()
	}
};

// Configuration globale Jest
beforeAll(async () => {
	// Configuration variables d'environnement test
	process.env.NODE_ENV = 'test';
	process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'mongodb://127.0.0.1:27017/konfirm_test';
	process.env.JWT_SECRET = 'test-jwt-secret-key-for-konfirm-lcbft';
	process.env.DG_TRESOR_API_URL = 'https://test-dgtresor.mock.api';
	process.env.ERMES_API_URL = 'https://test-ermes.mock.api';

	// Configuration logs pour tests
	process.env.LOG_LEVEL = 'error'; // Réduire verbosité pendant tests
});

// Configuration mocks globaux
jest.mock('../src/utils/logger', () => ({
	logSystemEvent: jest.fn(),
	logSecurityEvent: jest.fn(),
	logAuditEvent: jest.fn(),
	logError: jest.fn(),
	logWarning: jest.fn(),
	logInfo: jest.fn()
}));

jest.mock('../src/lib/prisma', () => ({
	__esModule: true,
	default: mockPrisma
}));

// Nettoyage après chaque test
afterEach(() => {
	// Reset tous les mocks après chaque test
	jest.clearAllMocks();
});

// Configuration timeout par défaut
jest.setTimeout(30000);

// Configuration console pour tests
global.console = {
	...console,
	log: jest.fn(), // Supprime logs pendant tests
	debug: jest.fn(),
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn()
};
