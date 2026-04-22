/**
 * Tests d'intégration LCB-FT - Workflow complet GODECHOT PAULIET
 *
 * Validation du flow complet de conformité LCB-FT depuis la réception
 * d'un dossier jusqu'à la déclaration TRACFIN si nécessaire.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import app from '../../src/app'; // Assuming you have express app exported

// Initialisation mocks
jest.mock('../../src/services/seuilsLcbFtService');
jest.mock('../../src/services/tracfinService');
jest.mock('../../src/utils/logger');

const mockPrisma = {
	user: {
		findUnique: jest.fn(),
		create: jest.fn(),
	},
	dossier: {
		create: jest.fn(),
		findUnique: jest.fn(),
		update: jest.fn(),
	},
	tracfinDeclaration: {
		create: jest.fn(),
		findMany: jest.fn(),
		update: jest.fn(),
	}
};

jest.mock('../../src/lib/prisma', () => ({
	__esModule: true,
	default: mockPrisma
}));

// Import des services mockés
const mockSeuilsService = require('../../src/services/seuilsLcbFtService');
const mockTracfinService = require('../../src/services/tracfinService');

describe('Workflow LCB-FT Intégration', () => {
	beforeEach(() => {
		jest.clearAllMocks();

		// Mock utilisateur authentifié
		mockPrisma.user.findUnique.mockResolvedValue({
			id: 'user-conseiller-1',
			email: 'conseiller@godechot-pauliet.fr',
			role: 'CONSEILLER',
			nom: 'Dupont',
			prenom: 'Marie'
		});
	});

	afterEach(() => {
		jest.resetAllMocks();
	});

	describe('Création dossier avec contrôles LCB-FT', () => {
		it('doit accepter dossier client occasionnel sous seuils', async () => {
			// Arrange
			mockSeuilsService.checkSeuilsLcbFt.mockResolvedValue({
				clientType: 'occasionnel',
				seuil: 15000,
				montant: 5000,
				controleRequis: false,
				vigilanceConstante: false
			});

			mockPrisma.dossier.create.mockResolvedValue({
				id: 'dossier-123',
				status: 'VALIDÉ'
			});

			const dossierData = {
				type: 'OUVERTURE_COMPTE',
				montant: 5000,
				moyenPaiement: 'carte',
				client: {
					civilite: 'M',
					nom: 'Martin',
					prenom: 'Paul',
					dateNaissance: '15/05/1985',
					adresse: '123 Rue de la République, 69001 Lyon',
					telephone: '0123456789',
					email: 'paul.martin@email.fr',
					nationalite: 'FR'
				}
			};

			// Act
			const response = await request(app)
				.post('/api/dossiers')
				.set('Authorization', 'Bearer valid-token')
				.send(dossierData);

			// Assert
			expect(response.status).toBe(201);
			expect(response.body.message).toBe('Dossier créé avec succès');
			expect(response.body.lcbftStatus).toBe('CONFORME');
			expect(response.body.tracfinRequired).toBe(false);

			expect(mockSeuilsService.checkSeuilsLcbFt).toHaveBeenCalledWith(
				expect.objectContaining({
					montant: 5000,
					client: expect.any(Object),
					moyenPaiement: 'carte'
				})
			);
		});

		it('doit déclencher contrôles renforcés pour client relation affaires > seuil', async () => {
			// Arrange
			mockSeuilsService.checkSeuilsLcbFt.mockResolvedValue({
				clientType: 'relation_affaires',
				seuil: 10000,
				montant: 15000,
				controleRequis: true,
				vigilanceConstante: true,
				recommendations: [
					'Vérification origine des fonds requise',
					'Justificatifs complémentaires nécessaires'
				]
			});

			mockPrisma.dossier.create.mockResolvedValue({
				id: 'dossier-456',
				status: 'EN_ATTENTE_CONTRÔLE'
			});

			const dossierDataElevé = {
				type: 'VIREMENT_ÉTRANGER',
				montant: 15000,
				moyenPaiement: 'virement',
				origineGeographique: 'DE',
				client: {
					civilite: 'Mme',
					nom: 'Dubois',
					prenom: 'Sophie',
					dateNaissance: '20/08/1974',
					adresse: '456 Avenue des Champs, 75008 Paris',
					telephone: '0987654321',
					email: 'sophie.dubois@email.fr',
					nationalite: 'FR',
					relationAffaires: true,
					dateDebutRelation: '01/01/2023'
				}
			};

			// Act
			const response = await request(app)
				.post('/api/dossiers')
				.set('Authorization', 'Bearer valid-token')
				.send(dossierDataElevé);

			// Assert
			expect(response.status).toBe(201);
			expect(response.body.lcbftStatus).toBe('CONTRÔLE_REQUIS');
			expect(response.body.vigilanceConstante).toBe(true);
			expect(response.body.recommendations).toHaveLength(2);
		});

		it('doit refuser dossier avec DG Trésor gel des avoirs', async () => {
			// Arrange
			mockSeuilsService.checkSeuilsLcbFt.mockResolvedValue({
				clientType: 'occasionnel',
				seuil: 15000,
				montant: 8000,
				controleRequis: false,
				vigilanceConstante: false
			});

			mockSeuilsService.checkGelAvoirsDGTresor.mockResolvedValue({
				isBlocked: true,
				source: 'DG_TRESOR',
				details: 'Personne inscrite sur la liste de gel des avoirs - Mesures restrictives UE',
				restrictionLevel: 'BLOCAGE_TOTAL'
			});

			const dossierBloque = {
				type: 'VIREMENT',
				montant: 8000,
				moyenPaiement: 'virement',
				client: {
					nom: 'PersonneBloquee',
					prenom: 'John',
					dateNaissance: '01/01/1970',
					nationalite: 'XX' // Nationalité confidentielle
				}
			};

			// Act
			const response = await request(app)
				.post('/api/dossiers')
				.set('Authorization', 'Bearer valid-token')
				.send(dossierBloque);

			// Assert
			expect(response.status).toBe(403);
			expect(response.body.error).toContain('Gel des avoirs');
			expect(response.body.lcbftStatus).toBe('REFUSÉ_DG_TRESOR');
			expect(response.body.blockingInfo.source).toBe('DG_TRESOR');
		});
	});

	describe('Évaluation TRACFIN et déclaration DSO', () => {
		beforeEach(() => {
			// Mock dossier existant
			mockPrisma.dossier.findUnique.mockResolvedValue({
				id: 'dossier-789',
				client: {
					nom: 'Suspect',
					prenom: 'Jean',
					dateNaissance: '10/03/1965'
				},
				montant: 45000,
				moyenPaiement: 'especes',
				origineGeographique: 'KY', // Cayman Islands
				status: 'VALIDÉ'
			});
		});

		it('doit évaluer suspicion et recommander DSO pour cas complexe', async () => {
			// Arrange
			mockTracfinService.evaluateSuspicion.mockReturnValue({
				score: 67,
				criteres: [
					{ code: 'TR003', description: 'Espèces importantes', poids: 15 },
					{ code: 'GEO002', description: 'Paradis fiscal', poids: 14 },
					{ code: 'TR001', description: 'Montant disproportionné', poids: 18 },
					{ code: 'ID002', description: 'PPE potentielle', poids: 20 }
				],
				risque: 'TRÈS_ÉLEVÉ',
				recommendDSO: true
			});

			// Act
			const response = await request(app)
				.post('/api/dossiers/dossier-789/tracfin/evaluate')
				.set('Authorization', 'Bearer valid-token')
				.send({
					hasIdentityIssues: false,
					isPEP: true,
					hasSanctions: false,
					hasGelAvoirs: false,
					clientBehavior: 'suspicious',
					transactionFrequency: 1
				});

			// Assert
			expect(response.status).toBe(200);
			expect(response.body.evaluation.score).toBe(67);
			expect(response.body.evaluation.risque).toBe('TRÈS_ÉLEVÉ');
			expect(response.body.evaluation.recommendDSO).toBe(true);
			expect(response.body.evaluation.criteres).toHaveLength(4);
		});

		it('doit générer et sauvegarder déclaration DSO', async () => {
			// Arrange
			const mockDeclaration = {
				id: 'DSO-1641234567-abc123def',
				dossierId: 'dossier-789',
				status: 'BROUILLON',
				evaluationSoupcon: {
					score: 67,
					risqueIdentifie: 'TRÈS_ÉLEVÉ'
				}
			};

			mockTracfinService.generateTracfinDeclaration.mockReturnValue(mockDeclaration);
			mockPrisma.tracfinDeclaration.create.mockResolvedValue(mockDeclaration);

			const declarationParams = {
				evaluationResult: {
					score: 67,
					criteres: [
						{ code: 'TR003', description: 'Espèces importantes' },
						{ code: 'GEO002', description: 'Paradis fiscal' }
					],
					risque: 'TRÈS_ÉLEVÉ',
					recommendDSO: true
				}
			};

			// Act
			const response = await request(app)
				.post('/api/dossiers/dossier-789/tracfin/declare')
				.set('Authorization', 'Bearer valid-token')
				.send(declarationParams);

			// Assert
			expect(response.status).toBe(201);
			expect(response.body.declaration.id).toBe('DSO-1641234567-abc123def');
			expect(response.body.declaration.status).toBe('BROUILLON');

			expect(mockTracfinService.generateTracfinDeclaration).toHaveBeenCalledWith(
				expect.objectContaining({
					dossierId: 'dossier-789',
					evaluationResult: declarationParams.evaluationResult
				})
			);
		});

		it('doit transmettre DSO à Ermès avec succès', async () => {
			// Arrange
			const mockDeclaration = {
				id: 'DSO-1641234567-abc123def',
				status: 'EN_ATTENTE'
			};

			mockPrisma.tracfinDeclaration.findUnique.mockResolvedValue(mockDeclaration);

			mockTracfinService.transmitToErmes.mockResolvedValue({
				success: true,
				ermesReference: 'ERMES-1641234567-X7Y9Z2',
				transmissionDate: new Date()
			});

			mockPrisma.tracfinDeclaration.update.mockResolvedValue({
				...mockDeclaration,
				status: 'TRANSMISE',
				ermesReference: 'ERMES-1641234567-X7Y9Z2'
			});

			// Act
			const response = await request(app)
				.post('/api/dossiers/dossier-789/tracfin/DSO-1641234567-abc123def/transmit')
				.set('Authorization', 'Bearer valid-token');

			// Assert
			expect(response.status).toBe(200);
			expect(response.body.success).toBe(true);
			expect(response.body.ermesReference).toBe('ERMES-1641234567-X7Y9Z2');
			expect(response.body.newStatus).toBe('TRANSMISE');

			expect(mockPrisma.tracfinDeclaration.update).toHaveBeenCalledWith({
				where: { id: 'DSO-1641234567-abc123def' },
				data: expect.objectContaining({
					status: 'TRANSMISE',
					ermesReference: 'ERMES-1641234567-X7Y9Z2'
				})
			});
		});

		it('doit gérer échec de transmission Ermès', async () => {
			// Arrange
			const mockDeclaration = {
				id: 'DSO-1641234567-abc123def',
				status: 'EN_ATTENTE'
			};

			mockPrisma.tracfinDeclaration.findUnique.mockResolvedValue(mockDeclaration);

			mockTracfinService.transmitToErmes.mockResolvedValue({
				success: false,
				error: 'Service Ermès temporairement indisponible'
			});

			// Act
			const response = await request(app)
				.post('/api/dossiers/dossier-789/tracfin/DSO-1641234567-abc123def/transmit')
				.set('Authorization', 'Bearer valid-token');

			// Assert
			expect(response.status).toBe(500);
			expect(response.body.success).toBe(false);
			expect(response.body.error).toContain('Service Ermès temporairement indisponible');

			// Le statut ne doit pas être modifié en cas d'erreur
			expect(mockPrisma.tracfinDeclaration.update).not.toHaveBeenCalled();
		});
	});

	describe('Workflow vigilance constante', () => {
		it('doit déclencher vigilance constante pour client à risque', async () => {
			// Arrange
			mockSeuilsService.checkVigilanceConstante.mockResolvedValue({
				vigilanceRequise: true,
				motifs: [
					'Client avec antécédents de transactions suspectes',
					'Présence sur liste de surveillance interne'
				],
				recommendations: [
					'Surveillance renforcée des transactions',
					'Validation systématique par responsable'
				],
				frequenceControle: 'MENSUELLE'
			});

			mockPrisma.dossier.findUnique.mockResolvedValue({
				id: 'dossier-vigilance-1',
				client: {
					nom: 'Surveille',
					prenom: 'Client'
				}
			});

			// Act
			const response = await request(app)
				.get('/api/dossiers/dossier-vigilance-1/vigilance')
				.set('Authorization', 'Bearer valid-token');

			// Assert
			expect(response.status).toBe(200);
			expect(response.body.vigilanceRequise).toBe(true);
			expect(response.body.motifs).toHaveLength(2);
			expect(response.body.frequenceControle).toBe('MENSUELLE');
		});

		it('doit lister toutes les déclarations TRACFIN pour audit', async () => {
			// Arrange
			const mockDeclarations = [
				{
					id: 'DSO-1',
					dossierId: 'dossier-1',
					status: 'TRANSMISE',
					ermesReference: 'ERMES-001',
					createdAt: new Date('2024-01-15'),
					evaluationSoupcon: { score: 45, risqueIdentifie: 'ÉLEVÉ' }
				},
				{
					id: 'DSO-2',
					dossierId: 'dossier-2',
					status: 'EN_ATTENTE',
					createdAt: new Date('2024-01-20'),
					evaluationSoupcon: { score: 38, risqueIdentifie: 'ÉLEVÉ' }
				}
			];

			mockPrisma.tracfinDeclaration.findMany.mockResolvedValue(mockDeclarations);

			// Act
			const response = await request(app)
				.get('/api/tracfin/declarations')
				.set('Authorization', 'Bearer valid-token')
				.query({ startDate: '2024-01-01', endDate: '2024-01-31' });

			// Assert
			expect(response.status).toBe(200);
			expect(response.body.declarations).toHaveLength(2);
			expect(response.body.summary.total).toBe(2);
			expect(response.body.summary.transmises).toBe(1);
			expect(response.body.summary.enAttente).toBe(1);

			expect(mockPrisma.tracfinDeclaration.findMany).toHaveBeenCalledWith({
				where: {
					createdAt: {
						gte: expect.any(Date),
						lte: expect.any(Date)
					}
				},
				orderBy: { createdAt: 'desc' }
			});
		});
	});

	describe('Gestion des erreurs et sécurité', () => {
		it('doit rejeter accès non autorisé pour routes TRACFIN', async () => {
			// Act
			const response = await request(app)
				.post('/api/dossiers/some-id/tracfin/evaluate')
				.send({});

			// Assert
			expect(response.status).toBe(401);
			expect(response.body.error).toContain('Token d\'authentification requis');
		});

		it('doit gérer erreur de service LCB-FT', async () => {
			// Arrange
			mockSeuilsService.checkSeuilsLcbFt.mockRejectedValue(
				new Error('Service LCB-FT temporairement indisponible')
			);

			const dossierData = {
				type: 'VIREMENT',
				montant: 5000,
				client: { nom: 'Test' }
			};

			// Act
			const response = await request(app)
				.post('/api/dossiers')
				.set('Authorization', 'Bearer valid-token')
				.send(dossierData);

			// Assert
			expect(response.status).toBe(500);
			expect(response.body.error).toContain('Erreur lors de la vérification LCB-FT');
			expect(response.body.lcbftStatus).toBe('ERREUR');
		});

		it('doit valider format des données client', async () => {
			// Act
			const response = await request(app)
				.post('/api/dossiers')
				.set('Authorization', 'Bearer valid-token')
				.send({
					type: 'VIREMENT',
					montant: 'invalid', // Montant invalide
					client: {
						nom: '', // Nom manquant
						email: 'email-invalide' // Format invalide
					}
				});

			// Assert
			expect(response.status).toBe(400);
			expect(response.body.errors).toContain('Le montant doit être un nombre positif');
			expect(response.body.errors).toContain('Le nom du client est obligatoire');
			expect(response.body.errors).toContain('Format d\'email invalide');
		});
	});
});
