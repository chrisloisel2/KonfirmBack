/**
 * Tests de conformité LCB-FT - Service TRACFIN GODECHOT PAULIET
 *
 * Validation des fonctionnalités TRACFIN selon les procédures internes :
 * - Évaluation automatique du niveau de suspicion
 * - Génération de déclarations de soupçon opérationnel (DSO)
 * - Interface avec plateforme Ermès
 * - Validation des critères de suspicion réglementaires
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
	evaluateSuspicion,
	generateTracfinDeclaration,
	transmitToErmes,
	validateDeclaration,
	CRITERES_SUSPICION
} from '../src/services/tracfinService';

// Mock axios pour les appels Ermès
jest.mock('axios');
const mockAxios = require('axios');

// Mock logger
jest.mock('../src/utils/logger', () => ({
	logSystemEvent: jest.fn(),
}));

describe('Service TRACFIN - Déclarations de Soupçon', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	afterEach(() => {
		jest.resetAllMocks();
	});

	describe('evaluateSuspicion - Évaluation niveau de suspicion', () => {
		it('doit classifier as FAIBLE pour transaction normale', () => {
			// Act
			const result = evaluateSuspicion({
				montant: 5000,
				clientType: 'occasionnel',
				moyenPaiement: 'carte',
				hasIdentityIssues: false,
				isPEP: false,
				hasSanctions: false,
				hasGelAvoirs: false,
				clientBehavior: 'normal',
				transactionFrequency: 1
			});

			// Assert
			expect(result.score).toBe(0);
			expect(result.criteres).toHaveLength(0);
			expect(result.risque).toBe('FAIBLE');
			expect(result.recommendDSO).toBe(false);
		});

		it('doit détecter PPE et montant élevé - risque MODÉRÉ', () => {
			// Act
			const result = evaluateSuspicion({
				montant: 25000, // > 15000 * 2 pour client occasionnel
				clientType: 'occasionnel',
				moyenPaiement: 'carte',
				hasIdentityIssues: false,
				isPEP: true,
				hasSanctions: false,
				hasGelAvoirs: false,
				clientBehavior: 'normal',
				transactionFrequency: 1
			});

			// Assert
			expect(result.score).toBe(32); // 20 (PPE) + 12 (montant élevé)
			expect(result.criteres).toHaveLength(2);
			expect(result.criteres.some(c => c.code === 'ID002')).toBe(true); // PPE
			expect(result.criteres.some(c => c.code === 'TR001')).toBe(true); // Montant élevé
			expect(result.risque).toBe('ÉLEVÉ');
			expect(result.recommendDSO).toBe(true);
		});

		it('doit déclencher DSO obligatoire pour gel des avoirs', () => {
			// Act
			const result = evaluateSuspicion({
				montant: 1000,
				clientType: 'occasionnel',
				moyenPaiement: 'carte',
				hasIdentityIssues: false,
				isPEP: false,
				hasSanctions: false,
				hasGelAvoirs: true, // Critère critique
				clientBehavior: 'normal',
				transactionFrequency: 1
			});

			// Assert
			expect(result.criteres.some(c => c.code === 'ID003')).toBe(true);
			expect(result.risque).toBe('TRÈS_ÉLEVÉ');
			expect(result.recommendDSO).toBe(true); // DSO obligatoire même avec score faible
		});

		it('doit analyser structuration de transactions - fréquence anormale', () => {
			// Act
			const result = evaluateSuspicion({
				montant: 8000,
				clientType: 'relation_affaires',
				moyenPaiement: 'especes',
				origineGeographique: 'FR',
				hasIdentityIssues: false,
				isPEP: false,
				hasSanctions: false,
				hasGelAvoirs: false,
				clientBehavior: 'evasive',
				transactionFrequency: 8 // Plus de 5 transactions en 7 jours
			});

			// Assert
			expect(result.criteres.some(c => c.code === 'TR003')).toBe(true); // Espèces importantes
			expect(result.criteres.some(c => c.code === 'COMP001')).toBe(true); // Comportement évasif
			expect(result.criteres.some(c => c.code === 'TEMP001')).toBe(true); // Fréquence anormale
			expect(result.score).toBeGreaterThan(30);
			expect(result.recommendDSO).toBe(true);
		});

		it('doit identifier pays à haut risque et paradis fiscal', () => {
			// Act
			const result1 = evaluateSuspicion({
				montant: 5000,
				clientType: 'occasionnel',
				moyenPaiement: 'virement',
				origineGeographique: 'AF', // Afghanistan - pays haut risque
				hasIdentityIssues: false,
				isPEP: false,
				hasSanctions: false,
				hasGelAvoirs: false
			});

			const result2 = evaluateSuspicion({
				montant: 5000,
				clientType: 'occasionnel',
				moyenPaiement: 'virement',
				origineGeographique: 'KY', // Cayman Islands - paradis fiscal
				hasIdentityIssues: false,
				isPEP: false,
				hasSanctions: false,
				hasGelAvoirs: false
			});

			// Assert
			expect(result1.criteres.some(c => c.code === 'GEO001')).toBe(true);
			expect(result2.criteres.some(c => c.code === 'GEO002')).toBe(true);
			expect(result1.score).toBe(16); // Pays à haut risque
			expect(result2.score).toBe(14); // Paradis fiscal
		});

		it('doit calculer score cumulé complexe - TRÈS_ÉLEVÉ', () => {
			// Act - Cas complexe avec multiples critères
			const result = evaluateSuspicion({
				montant: 35000, // Montant très élevé
				clientType: 'occasionnel',
				moyenPaiement: 'especes', // Espèces importantes
				origineGeographique: 'KY', // Paradis fiscal
				hasIdentityIssues: true,
				isPEP: true,
				hasSanctions: false,
				hasGelAvoirs: false,
				clientBehavior: 'suspicious',
				transactionFrequency: 10
			});

			// Assert
			expect(result.score).toBeGreaterThanOrEqual(50); // Score très élevé
			expect(result.risque).toBe('TRÈS_ÉLEVÉ');
			expect(result.recommendDSO).toBe(true);
			expect(result.criteres.length).toBeGreaterThan(5);
		});
	});

	describe('generateTracfinDeclaration - Génération DSO', () => {
		const mockEvaluationResult = {
			score: 45,
			criteres: [
				CRITERES_SUSPICION.find(c => c.code === 'ID002')!, // PPE
				CRITERES_SUSPICION.find(c => c.code === 'TR001')!  // Montant élevé
			],
			risque: 'ÉLEVÉ' as const,
			recommendDSO: true
		};

		const mockParams = {
			dossierId: 'test-dossier-123',
			clientInfo: {
				nom: 'Dupont',
				prenom: 'Jean',
				dateNaissance: '15/03/1975',
				nationalite: 'Française',
				adresse: '123 Rue de la Paix, 75001 Paris'
			},
			operationInfo: {
				montant: 25000,
				devise: 'EUR',
				dateOperation: new Date('2024-01-15'),
				moyenPaiement: 'virement',
				origineGeographique: 'FR'
			},
			evaluationResult: mockEvaluationResult,
			createdBy: 'user-responsable-123'
		};

		it('doit générer déclaration complète avec ID unique', () => {
			// Act
			const declaration = generateTracfinDeclaration(mockParams);

			// Assert
			expect(declaration.id).toMatch(/^DSO-\d+-[a-z0-9]{9}$/);
			expect(declaration.dossierId).toBe('test-dossier-123');
			expect(declaration.clientInfo.nom).toBe('Dupont');
			expect(declaration.clientInfo.prenom).toBe('Jean');
			expect(declaration.operationInfo.montant).toBe(25000);
			expect(declaration.evaluationSoupcon.score).toBe(45);
			expect(declaration.status).toBe('BROUILLON');
			expect(declaration.metadata.createdBy).toBe('user-responsable-123');
		});

		it('doit générer description automatique du soupçon', () => {
			// Act
			const declaration = generateTracfinDeclaration(mockParams);

			// Assert
			expect(declaration.operationInfo.description).toContain('Opération présentant 2 critère(s) de suspicion identifié(s)');
			expect(declaration.operationInfo.description).toContain('Personne politiquement exposée');
			expect(declaration.operationInfo.description).toContain('Transaction d\'un montant disproportionné');
			expect(declaration.operationInfo.description).toContain('Montant : 25000 EUR');
			expect(declaration.operationInfo.description).toContain('Moyen de paiement : virement');
		});

		it('doit logger la génération pour audit', () => {
			// Act
			const declaration = generateTracfinDeclaration(mockParams);

			// Assert
			expect(require('../src/utils/logger').logSystemEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'tracfin_declaration_generated',
					component: 'tracfinService',
					details: expect.objectContaining({
						declarationId: declaration.id,
						dossierId: 'test-dossier-123',
						score: 45,
						risque: 'ÉLEVÉ',
						recommendDSO: true,
						criteresCount: 2
					})
				})
			);
		});
	});

	describe('transmitToErmes - Transmission plateforme', () => {
		const mockDeclaration = {
			id: 'DSO-1641234567-abc123def',
			dossierId: 'dossier-test',
			clientInfo: {
				nom: 'Martin',
				prenom: 'Pierre',
				dateNaissance: '20/05/1980',
				nationalite: 'Française'
			},
			operationInfo: {
				montant: 30000,
				devise: 'EUR',
				dateOperation: new Date(),
				moyenPaiement: 'especes',
				natureSoupcon: 'Espèces importantes | PPE potentielle',
				description: 'Transaction en espèces de 30000 EUR par personne politiquement exposée'
			},
			evaluationSoupcon: {
				score: 48,
				criteres: ['Espèces importantes', 'PPE potentielle'],
				risqueIdentifie: 'ÉLEVÉ' as const,
				recommendationDSO: true
			},
			status: 'EN_ATTENTE' as const,
			metadata: {
				createdBy: 'responsable-456',
				createdAt: new Date(),
				lastModified: new Date()
			}
		};

		it('doit transmettre avec succès et retourner référence Ermès', async () => {
			// Arrange - Simulation transmission réussie

			// Act
			const result = await transmitToErmes(mockDeclaration);

			// Assert
			expect(result.success).toBe(true);
			expect(result.ermesReference).toMatch(/^ERMES-\d+-[A-Z0-9]{6}$/);
			expect(result.error).toBeUndefined();

			// Vérification des logs
			expect(require('../src/utils/logger').logSystemEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'ermes_transmission_start',
					component: 'tracfinService'
				})
			);
			expect(require('../src/utils/logger').logSystemEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'ermes_transmission_success',
					component: 'tracfinService',
					details: expect.objectContaining({
						declarationId: mockDeclaration.id,
						ermesReference: result.ermesReference
					})
				})
			);
		});

		it('doit gérer les erreurs de transmission', async () => {
			// Arrange
			const mockError = new Error('Service Ermès temporairement indisponible');
			// Forcer l'erreur en modifiant le comportement interne
			jest.spyOn(global, 'setTimeout').mockImplementation((callback, delay) => {
				if (typeof callback === 'function') {
					throw mockError;
				}
				return 0 as any;
			});

			// Act
			const result = await transmitToErmes(mockDeclaration);

			// Assert
			expect(result.success).toBe(false);
			expect(result.ermesReference).toBeUndefined();
			expect(result.error).toBe('Service Ermès temporairement indisponible');

			// Vérification log d'erreur
			expect(require('../src/utils/logger').logSystemEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'ermes_transmission_error',
					component: 'tracfinService',
					details: expect.objectContaining({
						declarationId: mockDeclaration.id,
						error: 'Service Ermès temporairement indisponible'
					})
				})
			);

			// Nettoyage
			jest.spyOn(global, 'setTimeout').mockRestore();
		});

		it('doit respecter le timeout de transmission', async () => {
			// Act - La simulation prend 2 secondes, devrait être OK
			const startTime = Date.now();
			const result = await transmitToErmes(mockDeclaration);
			const endTime = Date.now();

			// Assert
			expect(endTime - startTime).toBeGreaterThan(1900); // Au moins 2 secondes
			expect(endTime - startTime).toBeLessThan(3000); // Max 3 secondes
			expect(result.success).toBe(true);
		});
	});

	describe('validateDeclaration - Validation avant transmission', () => {
		const baseDeclaration = {
			id: 'DSO-test',
			dossierId: 'dossier-123',
			clientInfo: {
				nom: 'Doe',
				prenom: 'John',
				dateNaissance: '01/01/1980',
				nationalite: 'Française'
			},
			operationInfo: {
				montant: 15000,
				devise: 'EUR',
				dateOperation: new Date(),
				moyenPaiement: 'carte',
				natureSoupcon: 'Montant inhabituel',
				description: 'Transaction inhabituelle pour le profil client'
			},
			evaluationSoupcon: {
				score: 25,
				criteres: ['Montant inhabituel'],
				risqueIdentifie: 'MODÉRÉ' as const,
				recommendationDSO: true
			},
			status: 'BROUILLON' as const,
			metadata: {
				createdBy: 'user-123',
				createdAt: new Date(),
				lastModified: new Date()
			}
		};

		it('doit valider déclaration complète', () => {
			// Act
			const result = validateDeclaration(baseDeclaration);

			// Assert
			expect(result.isValid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('doit détecter informations client manquantes', () => {
			// Arrange
			const declarationIncomplete = {
				...baseDeclaration,
				clientInfo: {
					...baseDeclaration.clientInfo,
					nom: '', // Nom manquant
					nationalite: '' // Nationalité manquante
				}
			};

			// Act
			const result = validateDeclaration(declarationIncomplete);

			// Assert
			expect(result.isValid).toBe(false);
			expect(result.errors).toContain('Nom du client manquant');
			expect(result.errors).toContain('Nationalité manquante');
		});

		it('doit détecter score insuffisant pour DSO', () => {
			// Arrange
			const declarationScoreFaible = {
				...baseDeclaration,
				evaluationSoupcon: {
					...baseDeclaration.evaluationSoupcon,
					score: 10 // Score trop faible (< 15)
				}
			};

			// Act
			const result = validateDeclaration(declarationScoreFaible);

			// Assert
			expect(result.isValid).toBe(false);
			expect(result.errors).toContain('Score de suspicion insuffisant pour une déclaration TRACFIN');
		});

		it('doit détecter montant invalide', () => {
			// Arrange
			const declarationMontantInvalide = {
				...baseDeclaration,
				operationInfo: {
					...baseDeclaration.operationInfo,
					montant: 0 // Montant invalide
				}
			};

			// Act
			const result = validateDeclaration(declarationMontantInvalide);

			// Assert
			expect(result.isValid).toBe(false);
			expect(result.errors).toContain('Montant de l\'opération invalide');
		});

		it('doit détecter description manquante', () => {
			// Arrange
			const declarationSansDescription = {
				...baseDeclaration,
				operationInfo: {
					...baseDeclaration.operationInfo,
					description: '', // Description manquante
					natureSoupcon: '' // Nature du soupçon manquante
				}
			};

			// Act
			const result = validateDeclaration(declarationSansDescription);

			// Assert
			expect(result.isValid).toBe(false);
			expect(result.errors).toContain('Description du soupçon manquante');
			expect(result.errors).toContain('Nature du soupçon manquante');
		});
	});

	describe('Critères de suspicion - Configuration GODECHOT PAULIET', () => {
		it('doit contenir tous les critères obligatoires', () => {
			// Act & Assert
			expect(CRITERES_SUSPICION).toBeDefined();
			expect(CRITERES_SUSPICION.length).toBeGreaterThan(10);

			// Vérification présence critères critiques
			expect(CRITERES_SUSPICION.some(c => c.code === 'ID001')).toBe(true); // Identité douteuse
			expect(CRITERES_SUSPICION.some(c => c.code === 'ID002')).toBe(true); // PPE
			expect(CRITERES_SUSPICION.some(c => c.code === 'ID003')).toBe(true); // Gel des avoirs
			expect(CRITERES_SUSPICION.some(c => c.code === 'TR001')).toBe(true); // Montant élevé
			expect(CRITERES_SUSPICION.some(c => c.code === 'TR002')).toBe(true); // Structuration
		});

		it('doit avoir des poids cohérents pour critères critiques', () => {
			// Act
			const gelAvoirs = CRITERES_SUSPICION.find(c => c.code === 'ID003');
			const pep = CRITERES_SUSPICION.find(c => c.code === 'ID002');
			const structuration = CRITERES_SUSPICION.find(c => c.code === 'TR002');

			// Assert
			expect(gelAvoirs?.poids).toBe(20); // Poids maximum
			expect(pep?.poids).toBe(20); // Poids maximum
			expect(structuration?.poids).toBe(18); // Poids très élevé
		});

		it('doit avoir des domaines correctement définis', () => {
			// Act
			const domaines = [...new Set(CRITERES_SUSPICION.map(c => c.domaine))];

			// Assert
			expect(domaines).toEqual([
				'IDENTITÉ',
				'TRANSACTION',
				'COMPORTEMENT',
				'GÉOGRAPHIQUE',
				'TEMPOREL'
			]);
		});
	});
});
