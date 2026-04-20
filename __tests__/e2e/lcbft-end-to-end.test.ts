/**
 * Tests E2E LCB-FT - DG Trésor & Conformité réglementaire
 *
 * Tests de bout en bout pour validation complète du système LCB-FT
 * selon les exigences GODECHOT PAULIET et réglementation française.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import prisma from '../../src/lib/prisma';
import { checkGelAvoirsDGTresor, checkSeuilsLcbFt, checkVigilanceConstante } from '../src/services/seuilsLcbFtService';
import { evaluateSuspicion, generateTracfinDeclaration } from '../src/services/tracfinService';
import axios from 'axios';

// Mock axios pour les appels API externes
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Tests E2E LCB-FT - Conformité GODECHOT PAULIET', () => {
	beforeAll(async () => {
		await prisma.$connect();
	});

	afterAll(async () => {
		await prisma.$disconnect();
	});

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('Scénarios conformité DG Trésor', () => {
		it('doit bloquer client sur liste UE gel des avoirs', async () => {
			// Arrange - Simulation réponse positive DG Trésor
			mockedAxios.post.mockResolvedValueOnce({
				status: 200,
				data: {
					blocked: true,
					source: 'EU_SANCTIONS',
					details: 'Personne physique inscrite - Mesures restrictives Union européenne',
					regulation: 'Règlement (UE) 2023/1234',
					lastUpdate: '2024-01-15T10:30:00Z'
				}
			});

			const suspectClient = {
				nom: 'SANCTIONNE',
				prenom: 'Ivan',
				dateNaissance: '1968-03-15',
				nationalite: 'RU',
				adresse: 'Moscow, Russia'
			};

			// Act
			const result = await checkGelAvoirsDGTresor(suspectClient);

			// Assert
			expect(result.isBlocked).toBe(true);
			expect(result.source).toBe('DG_TRESOR');
			expect(result.details).toContain('Mesures restrictives Union européenne');
			expect(result.restrictionLevel).toBe('BLOCAGE_TOTAL');

			// Vérification appel API DG Trésor
			expect(mockedAxios.post).toHaveBeenCalledWith(
				expect.stringContaining('dgtresor.gov.fr'),
				expect.objectContaining({
					nom: 'SANCTIONNE',
					prenom: 'Ivan',
					dateNaissance: '1968-03-15'
				})
			);
		});

		it('doit autoriser client non sanctionné avec logs de vérification', async () => {
			// Arrange
			mockedAxios.post.mockResolvedValueOnce({
				status: 200,
				data: {
					blocked: false,
					verification_id: 'VER-20240115-789abc',
					checked_lists: ['EU_SANCTIONS', 'OFAC', 'UN_SANCTIONS'],
					timestamp: '2024-01-15T14:45:00Z'
				}
			});

			const clientLegal = {
				nom: 'Legrand',
				prenom: 'Pierre',
				dateNaissance: '1980-06-20',
				nationalite: 'FR',
				adresse: '12 Avenue de la Liberté, 75001 Paris'
			};

			// Act
			const result = await checkGelAvoirsDGTresor(clientLegal);

			// Assert
			expect(result.isBlocked).toBe(false);
			expect(result.verificationId).toBe('VER-20240115-789abc');
			expect(result.checkedLists).toContain('EU_SANCTIONS');
			expect(result.checkedLists).toContain('OFAC');
		});

		it('doit gérer indisponibilité temporaire service DG Trésor', async () => {
			// Arrange - Simulation timeout ou erreur réseau
			mockedAxios.post.mockRejectedValueOnce(new Error('Network timeout'));

			const clientTest = {
				nom: 'TestClient',
				prenom: 'John',
				dateNaissance: '1975-01-01',
				nationalite: 'US'
			};

			// Act
			const result = await checkGelAvoirsDGTresor(clientTest);

			// Assert - Mode dégradé avec recommandation contrôle manuel
			expect(result.isBlocked).toBe(false);
			expect(result.error).toContain('Service DG Trésor indisponible');
			expect(result.manualCheckRequired).toBe(true);
			expect(result.degradedMode).toBe(true);
		});
	});

	describe('Workflow complet LCB-FT - Cas réels', () => {
		it('Scénario 1: PPE avec montant élevé → DSO obligatoire', async () => {
			// Arrange - Données client PPE
			const clientPPE = {
				civilite: 'M',
				nom: 'MINISTRE',
				prenom: 'Jean',
				dateNaissance: '1960-08-12',
				nationalite: 'FR',
				adresse: 'République Française, 75008 Paris',
				relationAffaires: true,
				dateDebutRelation: '2023-06-01'
			};

			const operationElevee = {
				type: 'VIREMENT_INTERNATIONAL',
				montant: 85000, // > 8.5x seuil relation affaires
				devise: 'EUR',
				moyenPaiement: 'virement',
				origineGeographique: 'LU',
				destinataire: 'Société offshore Luxembourg'
			};

			// Act 1: Vérification seuils LCB-FT
			const seuilsResult = await checkSeuilsLcbFt({
				client: clientPPE,
				operation: operationElevee
			});

			// Act 2: Vérification DG Trésor
			mockedAxios.post.mockResolvedValueOnce({
				status: 200,
				data: { blocked: false, verification_id: 'VER-PPE-001' }
			});

			const dgTresorResult = await checkGelAvoirsDGTresor(clientPPE);

			// Act 3: Évaluation suspicion TRACFIN
			const suspicionResult = evaluateSuspicion({
				montant: operationElevee.montant,
				clientType: seuilsResult.clientType,
				moyenPaiement: operationElevee.moyenPaiement,
				origineGeographique: operationElevee.origineGeographique,
				hasIdentityIssues: false,
				isPEP: true, // Critère critique
				hasSanctions: false,
				hasGelAvoirs: dgTresorResult.isBlocked,
				clientBehavior: 'normal',
				transactionFrequency: 1
			});

			// Act 4: Génération DSO
			const declaration = generateTracfinDeclaration({
				dossierId: 'dossier-ppe-001',
				clientInfo: clientPPE,
				operationInfo: operationElevee,
				evaluationResult: suspicionResult,
				createdBy: 'responsable-lcbft-001'
			});

			// Assert - Workflow complet validé
			expect(seuilsResult.controleRequis).toBe(true);
			expect(seuilsResult.vigilanceConstante).toBe(true);
			expect(dgTresorResult.isBlocked).toBe(false);
			expect(suspicionResult.score).toBeGreaterThanOrEqual(32); // PPE(20) + Montant(12+)
			expect(suspicionResult.recommendDSO).toBe(true);
			expect(declaration.status).toBe('BROUILLON');
			expect(declaration.operationInfo.natureSoupcon).toContain('Personne politiquement exposée');
		});

		it('Scénario 2: Structuration transactions espèces → Alerte automatique', async () => {
			// Arrange - Client effectuant multiples transactions espèces
			const clientStructurant = {
				nom: 'Structurant',
				prenom: 'Michel',
				dateNaissance: '1971-04-18',
				nationalite: 'FR',
				relationAffaires: true,
				dateDebutRelation: '2024-01-01'
			};

			const transactions = [
				{ montant: 8500, moyenPaiement: 'especes', date: '2024-01-15' },
				{ montant: 9200, moyenPaiement: 'especes', date: '2024-01-16' },
				{ montant: 8800, moyenPaiement: 'especes', date: '2024-01-17' },
				{ montant: 9100, moyenPaiement: 'especes', date: '2024-01-18' },
				{ montant: 8600, moyenPaiement: 'especes', date: '2024-01-19' }
			];

			// Act - Analyse pattern de structuration
			const montantTotal = transactions.reduce((sum, t) => sum + t.montant, 0);
			const frequence = transactions.length;

			const suspicionResult = evaluateSuspicion({
				montant: montantTotal / frequence, // Montant moyen par transaction
				clientType: 'relation_affaires',
				moyenPaiement: 'especes',
				origineGeographique: 'FR',
				hasIdentityIssues: false,
				isPEP: false,
				hasSanctions: false,
				hasGelAvoirs: false,
				clientBehavior: 'evasive', // Comportement évasif observé
				transactionFrequency: frequence // 5 transactions en 5 jours
			});

			// Assert - Détection structuration
			expect(suspicionResult.criteres.some(c => c.code === 'TR002')).toBe(true); // Structuration
			expect(suspicionResult.criteres.some(c => c.code === 'TR003')).toBe(true); // Espèces importantes
			expect(suspicionResult.criteres.some(c => c.code === 'TEMP001')).toBe(true); // Fréquence anormale
			expect(suspicionResult.score).toBeGreaterThanOrEqual(40);
			expect(suspicionResult.risque).toBe('TRÈS_ÉLEVÉ');
		});

		it('Scénario 3: Paradis fiscal + comportement suspect → DSO complexe', async () => {
			// Arrange
			const clientParadisFiscal = {
				nom: 'Offshore',
				prenom: 'Company',
				dateNaissance: '1985-12-03',
				nationalite: 'KY', // Iles Cayman
				adresse: 'George Town, Grand Cayman',
				relationAffaires: false
			};

			const operationSuspecte = {
				type: 'DEPOT_ESPECES',
				montant: 47000, // > 3x seuil occasionnel
				devise: 'EUR',
				moyenPaiement: 'especes',
				origineGeographique: 'KY',
				description: 'Dépôt espèces sans justification claire'
			};

			// Act
			mockedAxios.post.mockResolvedValueOnce({
				status: 200,
				data: { blocked: false, verification_id: 'VER-OFF-001' }
			});

			const dgResult = await checkGelAvoirsDGTresor(clientParadisFiscal);

			const suspicionResult = evaluateSuspicion({
				montant: operationSuspecte.montant,
				clientType: 'occasionnel',
				moyenPaiement: operationSuspecte.moyenPaiement,
				origineGeographique: operationSuspecte.origineGeographique,
				hasIdentityIssues: true, // Documents suspects
				isPEP: false,
				hasSanctions: false,
				hasGelAvoirs: false,
				clientBehavior: 'suspicious', // Très suspect
				transactionFrequency: 1,
				hasUnclearOrigin: true // Origine des fonds unclear
			});

			const declaration = generateTracfinDeclaration({
				dossierId: 'dossier-offshore-001',
				clientInfo: clientParadisFiscal,
				operationInfo: operationSuspecte,
				evaluationResult: suspicionResult,
				createdBy: 'responsable-lcbft-002'
			});

			// Assert
			expect(suspicionResult.criteres.some(c => c.code === 'GEO002')).toBe(true); // Paradis fiscal
			expect(suspicionResult.criteres.some(c => c.code === 'TR003')).toBe(true); // Espèces importantes
			expect(suspicionResult.criteres.some(c => c.code === 'COMP002')).toBe(true); // Comportement suspect
			expect(suspicionResult.score).toBeGreaterThanOrEqual(50);
			expect(declaration.operationInfo.description).toContain('paradis fiscal');
			expect(declaration.operationInfo.description).toContain('espèces importantes');
		});
	});

	describe('Vigilance constante - Monitoring continu', () => {
		beforeEach(async () => {
			// Préparation base de données test
			await prisma.user.create({
				data: {
					id: 'vigilance-user-1',
					email: 'vigilance@test.fr',
					role: 'REFERENT',
					nom: 'Vigilant',
					prenom: 'Responsable'
				}
			});
		});

		it('doit identifier client nécessitant surveillance renforcée', async () => {
			// Arrange - Client avec antécédents
			const clientSurveillance = {
				id: 'client-surveillance-1',
				nom: 'Surveille',
				prenom: 'Pierre',
				relationAffaires: true,
				dateDebutRelation: '2023-01-15',
				historiqueTransactions: [
					{ score: 25, date: '2023-06-15', type: 'MONTANT_INHABITUEL' },
					{ score: 18, date: '2023-08-20', type: 'FRÉQUENCE_ÉLEVÉE' },
					{ score: 22, date: '2023-11-10', type: 'GÉOGRAPHIE_RISQUÉE' }
				]
			};

			// Act
			const vigilanceResult = await checkVigilanceConstante(clientSurveillance);

			// Assert
			expect(vigilanceResult.vigilanceRequise).toBe(true);
			expect(vigilanceResult.motifs).toContain('Historique de transactions suspectes');
			expect(vigilanceResult.recommendations).toContain('Surveillance renforcée des transactions');
			expect(vigilanceResult.frequenceControle).toBe('MENSUELLE');
			expect(vigilanceResult.scoreRisque).toBeGreaterThanOrEqual(65); // Score cumulé
		});

		it('doit déclencher alerte automatique pour évolution comportementale', async () => {
			// Arrange
			const clientEvolution = {
				id: 'client-evolution-1',
				profilInitial: {
					montantMoyenMensuel: 5000,
					frequenceMoyenne: 2,
					geographieHabituelle: ['FR', 'DE']
				},
				comportementRecent: {
					montantMoyenMensuel: 35000, // x7 augmentation
					frequenceMoyenne: 8, // x4 augmentation
					geographieRecente: ['KY', 'BZ'] // Nouveaux pays à risque
				}
			};

			// Act
			const vigilanceResult = await checkVigilanceConstante(clientEvolution);

			// Assert
			expect(vigilanceResult.vigilanceRequise).toBe(true);
			expect(vigilanceResult.motifs).toContain('Évolution significative du profil transactionnel');
			expect(vigilanceResult.alerteAutomatique).toBe(true);
			expect(vigilanceResult.priorite).toBe('HAUTE');
		});
	});

	describe('Audit et traçabilité', () => {
		it('doit enregistrer tous les événements LCB-FT pour audit', async () => {
			// Ce test vérifie que tous les événements critiques sont logs
			const mockLogger = require('../src/utils/logger');

			// Simulation workflow complet
			const client = { nom: 'AuditTest', prenom: 'Client' };
			const operation = { montant: 20000, moyenPaiement: 'virement' };

			await checkSeuilsLcbFt({ client, operation });
			await checkGelAvoirsDGTresor(client);

			const suspicion = evaluateSuspicion({
				montant: 20000,
				clientType: 'occasionnel',
				moyenPaiement: 'virement',
				hasIdentityIssues: false,
				isPEP: false,
				hasSanctions: false,
				hasGelAvoirs: false
			});

			// Vérification des logs d'audit
			expect(mockLogger.logSystemEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'lcbft_check_performed',
					component: 'seuilsLcbFtService',
					auditTrail: true
				})
			);

			expect(mockLogger.logSystemEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'dg_tresor_verification',
					component: 'seuilsLcbFtService',
					auditTrail: true
				})
			);

			expect(mockLogger.logSystemEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'suspicion_evaluation',
					component: 'tracfinService',
					auditTrail: true
				})
			);
		});
	});
});
