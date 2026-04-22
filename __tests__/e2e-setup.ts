/**
 * Setup E2E tests - Configuration base de données test complète
 */

import prisma from '../src/lib/prisma';

beforeAll(async () => {
	console.log('🚀 Initialisation tests E2E LCB-FT...');

	try {
		await prisma.$connect();

		// Seed données de test si nécessaire
		await cleanupTestData();
		await seedTestData();

		console.log('✅ Base de données test prête');
	} catch (error) {
		console.error('❌ Erreur initialisation base test:', error);
		throw error;
	}
});

afterAll(async () => {
	try {
		// Nettoyage données test
		await cleanupTestData();
		await prisma.$disconnect();
		console.log('✅ Nettoyage tests E2E terminé');
	} catch (error) {
		console.error('❌ Erreur nettoyage:', error);
	}
});

async function seedTestData() {
	// Création utilisateurs test
	await prisma.user.createMany({
		data: [
			{
				id: 'user-conseiller-e2e',
				email: 'conseiller.e2e@godechot-pauliet.fr',
				role: 'CONSEILLER',
				nom: 'Test',
				prenom: 'Conseiller'
			},
			{
				id: 'user-responsable-e2e',
				email: 'responsable.e2e@godechot-pauliet.fr',
				role: 'RESPONSABLE',
				nom: 'Test',
				prenom: 'Responsable'
			}
		],
		skipDuplicates: true
	});
}

async function cleanupTestData() {
	// Suppression en cascade respectant les contraintes FK
	await prisma.tracfinDeclaration.deleteMany({});
	await prisma.dossier.deleteMany({});
	await prisma.user.deleteMany({
		where: {
			email: {
				contains: '.e2e@'
			}
		}
	});
}

export { prisma };
