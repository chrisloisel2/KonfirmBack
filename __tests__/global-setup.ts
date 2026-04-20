/**
 * Setup global Jest - Initialisation environnement test complet
 */

async function globalSetup() {
	console.log('\n🔧 Initialisation suite de tests LCB-FT GODECHOT PAULIET...\n');

	// Configuration variables d'environnement globales
	process.env.NODE_ENV = 'test';
	process.env.CI = 'true';

	// Configuration base de données test
	if (!process.env.TEST_DATABASE_URL) {
		process.env.TEST_DATABASE_URL = 'mongodb://127.0.0.1:27017/konfirm_test';
	}

	// Configuration APIs mockées
	process.env.DG_TRESOR_API_URL = 'https://mock-dgtresor.test';
	process.env.ERMES_API_URL = 'https://mock-ermes.test';
	process.env.JWT_SECRET = 'konfirm-test-jwt-secret-lcbft';

	console.log('✅ Configuration environnement test terminée');
	console.log(`📊 Base de données test: ${process.env.TEST_DATABASE_URL}`);
	console.log(`🔐 Mode sécurisé: ${process.env.NODE_ENV}`);
	console.log('');
}

module.exports = globalSetup;
