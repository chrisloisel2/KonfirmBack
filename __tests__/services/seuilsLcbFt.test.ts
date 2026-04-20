/**
 * Tests de conformité LCB-FT - Service Seuils GODECHOT PAULIET
 *
 * Validation des fonctionnalités critiques selon les procédures internes :
 * - Détermination type de client (occasionnel vs relation d'affaires)
 * - Vérification gel des avoirs DG Trésor
 * - Vigilance constante pour clients existants
 * - Validation seuils 15000€ (occasionnel) et 10000€ (relation d'affaires)
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { checkSeuilsLcbFt, checkGelAvoirsDGTresor, checkVigilanceConstante } from '../src/services/seuilsLcbFtService';

// Mock Prisma
const mockPrisma = {
	dossier: {
		findMany: jest.fn(),
		count: jest.fn(),
	},
	client: {
		findFirst: jest.fn(),
	}
} as any;

jest.mock('../../src/lib/prisma', () => ({
	__esModule: true,
	default: mockPrisma
}));

// Mock axios pour les appels DG Trésor
jest.mock('axios');
const mockAxios = require('axios');

// Mock logger
jest.mock('../src/utils/logger', () => ({
	logSystemEvent: jest.fn(),
}));

describe('Service Seuils LCB-FT GODECHOT PAULIET', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	afterEach(() => {
		jest.resetAllMocks();
	});

	describe('checkSeuilsLcbFt - Détermination type de client', () => {
		it('doit classifier comme client occasionnel - première transaction', async () => {
			// Arrange
			mockPrisma.dossier.findMany.mockResolvedValue([]);

			// Act
			const result = await checkSeuilsLcbFt('TEST123456789', 12000, 'user-id-test');

			// Assert
			expect(result.clientType).toBe('occasionnel');
			expect(result.montantCumule).toBe(12000);
			expect(result.seuilApplique).toBe(15000);
			expect(result.depassementSeuil).toBe(false);
			expect(result.nombreTransactions).toBe(0);
		});

		it('doit classifier comme relation d\'affaires - transactions récurrentes dans 12 mois', async () => {
			// Arrange
			const dateRecente = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 jours
			mockPrisma.dossier.findMany.mockResolvedValue([
				{ montantInitial: 8000, createdAt: dateRecente },
				{ montantInitial: 5000, createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
				{ montantInitial: 3000, createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
			]);

			// Act
			const result = await checkSeuilsLcbFt('CLIENT987654321', 8000, 'user-id-test');

			// Assert
			expect(result.clientType).toBe('relation_affaires');
			expect(result.montantCumule).toBe(24000); // 8000 + 5000 + 3000 + 8000 (nouveau)
			expect(result.seuilApplique).toBe(10000);
			expect(result.depassementSeuil).toBe(true); // 24000 > 10000
			expect(result.nombreTransactions).toBe(3);
		});

		it('doit détecter dépassement seuil client occasionnel 15000€', async () => {
			// Arrange
			mockPrisma.dossier.findMany.mockResolvedValue([]);

			// Act
			const result = await checkSeuilsLcbFt('NOUVEAU123456', 16000, 'user-id-test');

			// Assert
			expect(result.clientType).toBe('occasionnel');
			expect(result.depassementSeuil).toBe(true);
			expect(result.seuilApplique).toBe(15000);
			expect(result.actionRequise).toBe('VERIFICATION_RENFORCEE');
		});

		it('doit calculer correctement les transactions liées sur 4 semaines', async () => {
			// Arrange
			const maintenant = new Date();
			const deuxSemainesAvant = new Date(maintenant.getTime() - 14 * 24 * 60 * 60 * 1000);
			const troisSemainesAvant = new Date(maintenant.getTime() - 21 * 24 * 60 * 60 * 1000);
			const cinqSemainesAvant = new Date(maintenant.getTime() - 35 * 24 * 60 * 60 * 1000);

			mockPrisma.dossier.findMany.mockResolvedValue([
				{ montantInitial: 6000, createdAt: deuxSemainesAvant },
				{ montantInitial: 7000, createdAt: troisSemainesAvant },
				{ montantInitial: 4000, createdAt: cinqSemainesAvant } // Hors fenêtre 4 semaines
			]);

			// Act
			const result = await checkSeuilsLcbFt('CLIENT456789', 5000, 'user-id-test');

			// Assert
			expect(result.montantCumuleQuatreSemaines).toBe(18000); // 6000 + 7000 + 5000 (exclu 4000)
			expect(result.transactionsLieesDetectees).toBe(true);
		});

		it('doit exiger déclaration TRACFIN si dépassement important', async () => {
			// Arrange
			mockPrisma.dossier.findMany.mockResolvedValue([]);

			// Act
			const result = await checkSeuilsLcbFt('GROS_MONTANT', 25000, 'user-id-test');

			// Assert
			expect(result.depassementSeuil).toBe(true);
			expect(result.actionRequise).toBe('DECLARATION_TRACFIN');
			expect(result.alerteNiveau).toBe('CRITIQUE');
		});
	});

	describe('checkGelAvoirsDGTresor - Vérification obligatoire', () => {
		it('doit retourner aucun match si personne non listée', async () => {
			// Arrange
			mockAxios.get.mockResolvedValue({
				data: '<html>Aucun résultat trouvé</html>',
				status: 200
			});

			// Act
			const result = await checkGelAvoirsDGTresor('Jean Dupont', 'user-id-test');

			// Assert
			expect(result.isBlocked).toBe(false);
			expect(result.matches).toHaveLength(0);
			expect(result.source).toBe('DG_TRESOR');
			expect(result.checkedAt).toBeDefined();
		});

		it('doit détecter un match et bloquer la transaction', async () => {
			// Arrange
			const htmlAvecMatch = `
        <html>
          <div class="container">
            <div class="result-item">
              <h3>DUPONT Jean Pierre</h3>
              <p>Né le: 15/03/1975</p>
              <p>Gel des avoirs: Arrêté du 12/01/2023</p>
            </div>
          </div>
        </html>
      `;
			mockAxios.get.mockResolvedValue({
				data: htmlAvecMatch,
				status: 200
			});

			// Act
			const result = await checkGelAvoirsDGTresor('Jean Pierre Dupont', 'user-id-test');

			// Assert
			expect(result.isBlocked).toBe(true);
			expect(result.matches).toContain('DUPONT Jean Pierre');
			expect(result.source).toBe('DG_TRESOR');
			expect(result.details).toContain('Match détecté');
		});

		it('doit gérer les erreurs de connexion DG Trésor', async () => {
			// Arrange
			mockAxios.get.mockRejectedValue(new Error('Network timeout'));

			// Act
			const result = await checkGelAvoirsDGTresor('Test User', 'user-id-test');

			// Assert
			expect(result.isBlocked).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.error).toContain('Network timeout');
			expect(result.source).toBe('DG_TRESOR');
		});

		it('doit respecter le délai de timeout configuré', async () => {
			// Arrange
			const delaiFn = jest.fn();
			mockAxios.get.mockImplementation(() => {
				return new Promise((resolve) => {
					setTimeout(() => {
						delaiFn();
						resolve({ data: 'Response tardive', status: 200 });
					}, 10000); // 10 secondes
				});
			});

			// Act - avec timeout de 8 secondes
			const startTime = Date.now();
			const result = await checkGelAvoirsDGTresor('Slow Response', 'user-id-test');
			const endTime = Date.now();

			// Assert
			expect(endTime - startTime).toBeLessThan(9000); // Doit timeout avant 9 secondes
			expect(result.error).toContain('timeout');
		});
	});

	describe('checkVigilanceConstante - Suivi clients existants', () => {
		it('doit détecter changement de profil significatif', async () => {
			// Arrange
			mockPrisma.client.findFirst.mockResolvedValue({
				id: 'client-123',
				revenus: 3000,
				patrimoineEstime: 50000,
				profession: 'Employé',
				updatedAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) // 6 mois
			});

			// Act
			const result = await checkVigilanceConstante('CLIENT123456789', {
				revenus: 15000, // +400% d'augmentation revenus
				patrimoineEstime: 200000,
				profession: 'Dirigeant'
			}, 'user-id-test');

			// Assert
			expect(result.alertes).toContain('CHANGEMENT_REVENUS_SIGNIFICATIF');
			expect(result.alertes).toContain('CHANGEMENT_PATRIMOINE_SIGNIFICATIF');
			expect(result.alertes).toContain('CHANGEMENT_PROFESSION');
			expect(result.niveauVigilance).toBe('ELEVE');
			expect(result.actionRequise).toBe('VERIFICATION_MANUELLE');
		});

		it('doit signaler fréquence de transactions anormale', async () => {
			// Arrange
			const dateSemaineDerniere = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
			mockPrisma.dossier.findMany.mockResolvedValue([
				{ createdAt: new Date() },
				{ createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) },
				{ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
				{ createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
				{ createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) },
			]); // 5 transactions en 4 jours

			mockPrisma.client.findFirst.mockResolvedValue({
				id: 'client-frequent',
				revenus: 3000,
				patrimoineEstime: 50000
			});

			// Act
			const result = await checkVigilanceConstante('FREQUENT_USER', {}, 'user-id-test');

			// Assert
			expect(result.alertes).toContain('FREQUENCE_ANORMALE');
			expect(result.frequenceTransactions).toBe(5);
			expect(result.niveauVigilance).toBe('MODERE');
		});

		it('doit valider profil stable sans alertes', async () => {
			// Arrange
			mockPrisma.client.findFirst.mockResolvedValue({
				id: 'client-stable',
				revenus: 3000,
				patrimoineEstime: 50000,
				profession: 'Employé',
				updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
			});

			mockPrisma.dossier.findMany.mockResolvedValue([
				{ createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
			]); // 1 transaction par mois

			// Act
			const result = await checkVigilanceConstante('STABLE_CLIENT', {
				revenus: 3100, // +3% augmentation normale
				patrimoineEstime: 52000,
				profession: 'Employé'
			}, 'user-id-test');

			// Assert
			expect(result.alertes).toHaveLength(0);
			expect(result.niveauVigilance).toBe('FAIBLE');
			expect(result.actionRequise).toBe('AUCUNE');
			expect(result.profilStable).toBe(true);
		});
	});

	describe('Intégration complète LCB-FT', () => {
		it('doit orchestrer toutes les vérifications pour nouveau client fort montant', async () => {
			// Arrange
			mockPrisma.dossier.findMany.mockResolvedValue([]);
			mockAxios.get.mockResolvedValue({
				data: '<html>Aucun résultat</html>',
				status: 200
			});

			// Act - Client occasionnel avec 20000€
			const seuilResult = await checkSeuilsLcbFt('NOUVEAU_GROS', 20000, 'user-id-test');
			const gelResult = await checkGelAvoirsDGTresor('Pierre Martin', 'user-id-test');

			// Assert
			expect(seuilResult.clientType).toBe('occasionnel');
			expect(seuilResult.depassementSeuil).toBe(true);
			expect(seuilResult.actionRequise).toBe('DECLARATION_TRACFIN');
			expect(gelResult.isBlocked).toBe(false);

			// Vérification des logs d'audit
			expect(require('../src/utils/logger').logSystemEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'seuil_lcb_ft_check',
					component: 'seuilsLcbFtService',
					details: expect.objectContaining({
						clientType: 'occasionnel',
						depassementSeuil: true,
					})
				})
			);
		});

		it('doit bloquer immédiatement si gel des avoirs détecté', async () => {
			// Arrange
			const htmlBlocage = `
        <html>
          <div class="result-item">
            <h3>MARTIN Pierre Alexandre</h3>
            <p>Gel des avoirs confirmé</p>
          </div>
        </html>
      `;
			mockAxios.get.mockResolvedValue({
				data: htmlBlocage,
				status: 200
			});

			// Act
			const result = await checkGelAvoirsDGTresor('Pierre Alexandre Martin', 'user-id-test');

			// Assert
			expect(result.isBlocked).toBe(true);
			expect(result.matches).toContain('MARTIN Pierre Alexandre');
			expect(result.actionRequise).toBe('BLOCAGE_IMMEDIAT');

			// Le processus doit être immédiatement arrêté
			// En production, ceci déclencherait une exception dans l'API
		});
	});

	describe('Cas limites et erreurs', () => {
		it('doit gérer les montants négatifs', async () => {
			// Arrange & Act & Assert
			await expect(
				checkSeuilsLcbFt('TEST', -1000, 'user-id-test')
			).rejects.toThrow('Montant invalide');
		});

		it('doit gérer les identifiants vides', async () => {
			// Arrange & Act & Assert
			await expect(
				checkSeuilsLcbFt('', 1000, 'user-id-test')
			).rejects.toThrow('Numéro d\'identité requis');
		});

		it('doit gérer les erreurs de base de données', async () => {
			// Arrange
			mockPrisma.dossier.findMany.mockRejectedValue(new Error('Database connection failed'));

			// Act & Assert
			await expect(
				checkSeuilsLcbFt('TEST', 1000, 'user-id-test')
			).rejects.toThrow('Database connection failed');
		});

		it('doit traiter les caractères spéciaux dans les noms', async () => {
			// Arrange
			mockAxios.get.mockResolvedValue({
				data: '<html>Aucun résultat</html>',
				status: 200
			});

			// Act
			const result = await checkGelAvoirsDGTresor('Jean-François O\'Connor', 'user-id-test');

			// Assert
			expect(result.isBlocked).toBe(false);
			expect(mockAxios.get).toHaveBeenCalledWith(
				expect.stringContaining('Jean-Fran%C3%A7ois%20O%27Connor')
			);
		});
	});
});
