# Konfirm Backend - API de Conformité LCB-FT

Backend Node.js/TypeScript pour l'application de conformité LCB-FT (Lutte Contre le Blanchiment et le Financement du Terrorisme).

## 🚀 Fonctionnalités

### Conformité LCB-FT
- ✅ Gestion complète des dossiers clients
- ✅ Upload et traitement OCR des documents
- ✅ Recherches automatisées (PPE, Sanctions, Gel des avoirs)
- ✅ Moteur de scoring et d'évaluation des risques
- ✅ Gestion des exceptions et validation humaine
- ✅ Audit trail complet avec rétention 5 ans

### Sécurité et Authentification
- ✅ Authentification JWT avec sessions
- ✅ Contrôle d'accès basé sur les rôles (RBAC)
- ✅ Rate limiting et protection contre les attaques
- ✅ Chiffrement des données sensibles
- ✅ Logs de sécurité et détection d'intrusions

### Architecture Technique
- ✅ API REST avec TypeScript
- ✅ Base de données MongoDB
- ✅ Cache Redis pour les sessions
- ✅ Upload de fichiers avec OCR (Tesseract)
- ✅ Intégration APIs externes pour vérifications

## 📋 Prérequis

- **Node.js** 18+
- **MongoDB** 7+
- **Redis** 7+
- **TypeScript** configuré
- **Tesseract OCR** pour le traitement des documents

## 🛠️ Installation

### 1. Cloner et installer les dépendances

```bash
cd Konfirback
npm install
```

### 2. Configuration de la base de données

```bash
# Installer MongoDB Community Edition (macOS)
brew tap mongodb/brew
brew install mongodb-community
brew services start mongodb-community
```

### 3. Configuration Redis

```bash
# Installer Redis (macOS)
brew install redis
brew services start redis
```

### 4. Variables d'environnement

```bash
# Copier le fichier d'exemple
cp .env.example .env

# Éditer .env avec vos valeurs
nano .env
```

### 5. Initialisation MongoDB

```bash
# Seed initial (admin + configuration)
npm run db:setup
```

## ⚙️ Configuration

### Variables d'environnement essentielles

```env
# Base de données
DATABASE_URL="mongodb://127.0.0.1:27017/konfirm_db"

# Redis
REDIS_URL="redis://localhost:6379"

# Sécurité
JWT_SECRET="your-super-secret-jwt-key"
SESSION_SECRET="your-session-secret-key"

# APIs externes LCB-FT
PPE_API_URL="https://your-ppe-api.com"
PPE_API_KEY="your-api-key"
SANCTIONS_API_URL="https://your-sanctions-api.com"
SANCTIONS_API_KEY="your-api-key"
```

### Configuration OCR

```env
# Tesseract OCR
OCR_LANGUAGES=fra,eng
OCR_CONFIDENCE_THRESHOLD=0.7
```

### Configuration du scoring

```env
# Pondération des facteurs de risque
SCORING_PPE_WEIGHT=40
SCORING_SANCTIONS_WEIGHT=40
SCORING_ASSET_FREEZE_WEIGHT=20

# Seuils de décision
SCORING_THRESHOLD_LOW=30
SCORING_THRESHOLD_MEDIUM=60
SCORING_THRESHOLD_HIGH=85
```

## 🚀 Démarrage

### Mode développement

```bash
npm run dev
```

### Mode production

```bash
npm run build
npm start
```

### Tests

```bash
npm test
npm run test:coverage
```

## 📡 API Endpoints

### Authentification
- `POST /api/auth/login` - Connexion utilisateur
- `POST /api/auth/logout` - Déconnexion
- `GET /api/auth/me` - Profil utilisateur
- `POST /api/auth/change-password` - Changement de mot de passe

### Dossiers
- `GET /api/dossiers` - Liste des dossiers (paginée + filtres)
- `POST /api/dossiers` - Création d'un nouveau dossier
- `GET /api/dossiers/:id` - Détails d'un dossier
- `PATCH /api/dossiers/:id` - Mise à jour d'un dossier
- `POST /api/dossiers/:id/assign` - Assignation d'un dossier

### Documents
- `POST /api/documents/dossiers/:id/upload` - Upload de documents
- `GET /api/documents/dossiers/:id` - Liste des documents
- `GET /api/documents/:id` - Détails d'un document
- `GET /api/documents/:id/download` - Téléchargement
- `PATCH /api/documents/:id/verify` - Validation d'un document

### Recherches LCB-FT
- `POST /api/recherches/dossiers/:id/ppe` - Recherche PPE
- `POST /api/recherches/dossiers/:id/sanctions` - Recherche sanctions
- `POST /api/recherches/dossiers/:id/asset-freeze` - Recherche gel des avoirs
- `POST /api/recherches/dossiers/:id/complete` - Recherche complète
- `GET /api/recherches/dossiers/:id` - Historique des recherches

### Scoring et Risques
- `POST /api/scoring/dossiers/:id` - Calcul du scoring
- `GET /api/scoring/dossiers/:id` - Scoring d'un dossier
- `GET /api/scoring/dossiers/:id/preview` - Aperçu du scoring
- `GET /api/scoring/stats` - Statistiques de scoring

### Exceptions
- `GET /api/exceptions` - Liste des exceptions (paginée + filtres)
- `POST /api/exceptions` - Création d'une exception
- `PATCH /api/exceptions/:id` - Mise à jour d'une exception
- `POST /api/exceptions/:id/assign` - Attribution d'une exception
- `GET /api/exceptions/my-assignments` - Mes exceptions assignées

## 🔐 Rôles et Permissions

### CONSEILLER
- Création et gestion de ses propres dossiers
- Upload et vérification de documents
- Lancement des recherches LCB-FT
- Visualisation du scoring

### CAISSE
- Même permissions que CONSEILLER
- Accès aux dossiers qui lui sont assignés

### REFERENT
- Toutes les permissions des rôles précédents
- Assignation des dossiers et exceptions
- Validation des exceptions de niveau moyen

### RESPONSABLE
- Toutes les permissions des rôles précédents
- Validation/rejet des dossiers
- Gestion des exceptions critiques
- Accès aux statistiques avancées

### ADMIN
- Toutes les permissions
- Gestion des utilisateurs
- Configuration du système
- Accès aux logs d'audit

## 📊 Monitoring et Logs

### Logs de conformité
- Tous les événements sont tracés avec horodatage immutable
- Rétention automatique de 5 ans
- Intégrité cryptographique des logs d'audit
- Séparation des logs par criticité

### Métriques
- Temps de réponse des APIs externes
- Taux de détection des correspondances
- Performance du moteur de scoring
- Statistiques d'utilisation par rôle

## 🛡️ Sécurité

### Authentification et autorisation
- JWT avec expiration automatique
- Sessions avec Redis pour révocation instantanée
- Verrouillage de compte après échecs de connexion
- Audit complet des accès

### Protection des données
- Chiffrement AES-256 pour les données sensibles
- Hachage bcrypt pour les mots de passe
- Validation stricte des entrées utilisateur
- Rate limiting adaptatif

### Conformité RGPD
- Anonymisation des données après archivage
- Logs de tous les accès aux données personnelles
- Possibilité d'export des données client
- Effacement sécurisé sur demande

## 🔧 Maintenance

### Sauvegarde
```bash
# Dump MongoDB
mongodump --db konfirm_db --out backup_$(date +%Y%m%d_%H%M%S)

# Sauvegarde des fichiers
tar -czf files_backup_$(date +%Y%m%d_%H%M%S).tar.gz uploads/
```

### Mise à jour
```bash
# Mise à jour des dépendances
npm update

# Réinitialisation du seed MongoDB
npm run db:setup

# Redémarrage en production
pm2 restart konfirm-api
```

## 🐛 Dépannage

### Problèmes courants

**Erreur de connexion MongoDB**
```bash
# Vérifier le statut
brew services list | grep mongodb
# Redémarrer si nécessaire
brew services restart mongodb-community
```

**Erreur OCR Tesseract**
```bash
# Installation macOS
brew install tesseract tesseract-lang

# Vérifier l'installation
tesseract --version
```

**Problème de permissions de fichiers**
```bash
# Corriger les permissions du dossier uploads
chmod 755 uploads/
chown -R $USER:$GROUP uploads/
```

## 📚 Documentation additionnelle

- [Adaptateur MongoDB](./src/lib/prisma.ts) - Couche d'accès aux collections
- [Types TypeScript](./src/shared/types/) - Définitions des types
- [Middleware de sécurité](./src/middleware/) - Authentification et autorisations
- [Configuration](./src/config/) - Configuration de l'application

## 🤝 Contribution

1. Fork du projet
2. Créer une branche feature (`git checkout -b feature/AmazingFeature`)
3. Commit des changements (`git commit -m 'Add AmazingFeature'`)
4. Push vers la branche (`git push origin feature/AmazingFeature`)
5. Ouvrir une Pull Request

## 📄 Licence

Ce projet est sous licence propriétaire. Voir le fichier [LICENSE](LICENSE) pour plus de détails.

## 📞 Support

Pour toute question ou problème :
- 📧 Email: support@konfirm.com
- 📋 Issues: [GitHub Issues](https://github.com/konfirm/backend/issues)
- 📖 Documentation: [Confluence Konfirm]

---

**⚠️ Note importante:** Cette application traite des données financières sensibles. Assurez-vous de suivre toutes les procédures de sécurité et de conformité en vigueur avant le déploiement en production.
