# Tests LCB-FT - Suite de Conformité GODECHOT PAULIET

Documentation complète des tests de conformité réglementaire pour l'application Konfirm.

## 🎯 Objectif

Cette suite de tests valide la conformité totale de l'application Konfirm aux exigences LCB-FT (Lutte Contre le Blanchiment et le Financement du Terrorisme) selon les procédures internes GODECHOT PAULIET et la réglementation française.

## 📋 Couverture des Tests

### 1. Tests Unitaires (`__tests__/services/`)

#### **seuilsLcbFt.test.ts** - Service Seuils LCB-FT
- ✅ Détermination type de client (occasionnel vs relation d'affaires)
- ✅ Validation seuils réglementaires (15 000€ / 10 000€)
- ✅ Vérification DG Trésor gel des avoirs
- ✅ Vigilance constante et surveillance renforcée
- ✅ Gestion erreurs et modes dégradés

#### **tracfin.test.ts** - Service TRACFIN
- ✅ Évaluation automatique du niveau de suspicion
- ✅ Génération déclarations de soupçon opérationnel (DSO)
- ✅ Interface plateforme Ermès
- ✅ Validation critères suspicion réglementaires
- ✅ Pondération et scores de suspicion

### 2. Tests d'Intégration (`__tests__/integration/`)

#### **lcbft-workflow.test.ts** - Workflow Complet
- ✅ Création dossiers avec contrôles LCB-FT intégrés
- ✅ API routes avec middleware de conformité
- ✅ Évaluation TRACFIN et déclaration DSO
- ✅ Transmission Ermès avec gestion d'erreurs
- ✅ Vigilance constante et audit trail

### 3. Tests End-to-End (`__tests__/e2e/`)

#### **lcbft-end-to-end.test.ts** - Scénarios Réels
- ✅ PPE avec montant élevé → DSO automatique
- ✅ Structuration transactions espèces → Alerte
- ✅ Paradis fiscal + comportement suspect
- ✅ Monitoring continu et évolution comportementale
- ✅ Audit complet et traçabilité

## 🚀 Exécution des Tests

### Installation des Dépendances

```bash
# Backend
cd KonfirmBack
npm install

# Configuration base de données test
npm run db:setup:test
```

### Scripts de Test Disponibles

```bash
# Tests complets avec coverage
npm run test:all

# Tests unitaires uniquement
npm run test:unit

# Tests d'intégration API
npm run test:integration

# Tests end-to-end
npm run test:e2e

# Tests LCB-FT (unit + integration)
npm run test:lcbft

# Mode watch pour développement
npm run test:watch

# Coverage détaillé
npm run test:coverage

# Mode CI/CD
npm run test:ci
```

### Commandes spécifiques

```bash
# Test d'un seul fichier
npx jest __tests__/services/seuilsLcbFt.test.ts

# Tests avec pattern
npx jest --testNamePattern="PPE"

# Tests avec verbose
npx jest --verbose --detectOpenHandles
```

## 📊 Métriques de Couverture

### Objectifs de Couverture
- **Services LCB-FT**: > 95%
- **API Routes conformité**: > 90%
- **Workflow complet**: > 85%
- **Gestion erreurs**: 100%

### Fichiers Critiques Couverts
- `seuilsLcbFtService.ts` - ⭐ Service principal conformité
- `tracfinService.ts` - ⭐ Déclarations TRACFIN
- `identityVerificationService.ts` - Vérification identité
- `routes/dossiers.ts` - API conformité
- `src/lib/prisma.ts` - Adaptateur MongoDB utilisé par les services

## 🔍 Critères de Validation

### Conformité Réglementaire
- [x] Seuils LCB-FT : 15 000€ (occasionnel) / 10 000€ (relation affaires)
- [x] Vérification DG Trésor gel des avoirs
- [x] Détection PPE (Personnes Politiquement Exposées)
- [x] Identification pays à haut risque / paradis fiscaux
- [x] Structuration transactions et fréquence anormale
- [x] Déclarations TRACFIN automatiques (DSO)
- [x] Interface plateforme Ermès
- [x] Vigilance constante et surveillance renforcée

### Qualité Technique
- [x] Gestion d'erreurs robuste
- [x] Logging audit complet
- [x] Validation données entrée
- [x] Sécurité et authentification
- [x] Performance et timeout
- [x] Mode dégradé en cas d'indisponibilité

## 📁 Structure des Tests

```
__tests__/
├── services/                    # Tests unitaires services
│   ├── seuilsLcbFt.test.ts     # ⭐ Service seuils LCB-FT
│   └── tracfin.test.ts         # ⭐ Service TRACFIN
├── integration/                 # Tests intégration API
│   └── lcbft-workflow.test.ts  # Workflow complet
├── e2e/                        # Tests end-to-end
│   └── lcbft-end-to-end.test.ts # Scénarios réels
├── setup.ts                    # Configuration globale
├── integration-setup.ts        # Setup API tests
├── e2e-setup.ts               # Setup E2E tests
├── global-setup.ts            # Setup Jest global
└── global-teardown.ts         # Cleanup Jest global
```

## 🔧 Configuration

### Variables d'Environnement Test (`.env.test`)
```bash
NODE_ENV=test
DATABASE_URL="mongodb://127.0.0.1:27017/konfirm_test"
DG_TRESOR_API_URL="https://mock-dgtresor.test.api"
ERMES_API_URL="https://mock-ermes.test.api"
JWT_SECRET="konfirm-test-jwt-secret-lcbft"
LOG_LEVEL="error"
```

### Configuration Jest (`jest.config.json`)
- Projets multiples (unit, integration, e2e)
- Coverage par type de test
- Timeout adaptatif
- Mocks globaux du client base interne et APIs

## ⚠️ Prérequis Système

### Base de Données Test
```bash
# MongoDB local pour tests
mongosh --eval "db.getSiblingDB('konfirm_test').dropDatabase()"
```

### Services Mockés
- DG Trésor API (vérification gel avoirs)
- Plateforme Ermès (transmission TRACFIN)
- Services identité et géolocalisation

## 🚨 Scenarios de Test Critiques

### Cas de Test Obligatoires
1. **Client PPE + montant élevé** → DSO automatique
2. **Gel des avoirs DG Trésor** → Blocage total
3. **Structuration espèces** → Alerte suspicion
4. **Paradis fiscal** → Surveillance renforcée
5. **Indisponibilité service** → Mode dégradé

### Validation Réglementaire
- Respect seuils européens et français
- Conformité procédures GODECHOT PAULIET
- Intégration réglementaire TRACFIN
- Audit trail complet

## 📈 Monitoring et Reporting

### Rapports Générés
- `coverage/` - Rapport de couverture HTML
- `logs/konfirm-test.log` - Logs détaillés tests
- Console output avec métriques temps réel

### Intégration CI/CD
```yaml
# GitHub Actions / GitLab CI
script:
  - npm run test:ci
  - npm run test:coverage
  - npm run lint
```

## 🔄 Maintenance Tests

### Fréquence de Mise à Jour
- **Quotidienne** : Tests unitaires pendant développement
- **Hebdomadaire** : Tests intégration et e2e
- **Règlementaire** : Mise à jour selon évolutions LCB-FT

### Monitoring Qualité
- Coverage minimum maintenu > 90%
- Aucun test en échec toléré
- Performance tests < 30s pour suite complète

---

## 📞 Support et Documentation

For questions about LCB-FT compliance testing:
- **Technical**: Tests implementation and debugging
- **Regulatory**: GODECHOT PAULIET procedures alignment
- **Integration**: API endpoints and workflow validation

**Status**: ✅ **Conforme LCB-FT** - Validation complète selon procedures GODECHOT PAULIET
