/**
 * Teardown global Jest - Nettoyage environnement test
 */

async function globalTeardown() {
	console.log('\n🧹 Nettoyage suite de tests LCB-FT...');

	// Nettoyage variables d'environnement si nécessaire
	delete process.env.TEST_DATABASE_URL;
	delete process.env.DG_TRESOR_API_URL;
	delete process.env.ERMES_API_URL;

	console.log('✅ Nettoyage environnement test terminé\n');
}

module.exports = globalTeardown;
