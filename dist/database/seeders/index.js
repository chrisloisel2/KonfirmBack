"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_1 = __importDefault(require("../../lib/prisma"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
async function seedScoringConfig() {
    console.log('⚙️  Seeding scoring configuration...');
    const existing = await prisma_1.default.configurationScoring.findUnique({ where: { nom: 'default' } });
    if (existing) {
        console.log('   Scoring config already exists, skipping.');
        return existing;
    }
    const config = await prisma_1.default.configurationScoring.create({
        data: {
            nom: 'default',
            description: 'Configuration de scoring LCB-FT standard (GODECHOT PAULIET)',
            isActive: true,
            poidsppe: 0.4,
            poidsSanctions: 0.4,
            poidsAssetFreeze: 0.2,
            seuilFaible: 30,
            seuilMoyen: 60,
            seuilEleve: 85,
        },
    });
    const facteurs = [
        // ── Profession ───────────────────────────────────────────────────────────
        { categorie: 'profession', valeur: 'politique', points: 50, niveau: 'CRITIQUE', description: 'Personnalité politique exposée (PPE)' },
        { categorie: 'profession', valeur: 'diplomate', points: 40, niveau: 'ELEVE', description: 'Diplomate en poste' },
        { categorie: 'profession', valeur: 'dirigeant', points: 30, niveau: 'ELEVE', description: "Dirigeant d'entreprise d'importance" },
        { categorie: 'profession', valeur: 'militaire', points: 25, niveau: 'MOYEN', description: 'Haut gradé militaire' },
        { categorie: 'profession', valeur: 'magistrat', points: 20, niveau: 'MOYEN', description: 'Magistrat ou fonctionnaire judiciaire' },
        { categorie: 'profession', valeur: 'avocat', points: 10, niveau: 'FAIBLE', description: 'Avocat ou conseil juridique' },
        { categorie: 'profession', valeur: 'default', points: 0, niveau: null, description: 'Profession sans surrisque identifié' },
        // ── Nationalité (pays GAFI à risque élevé) ───────────────────────────────
        { categorie: 'nationalite', valeur: 'north_korea', points: 100, niveau: 'CRITIQUE', description: 'Corée du Nord – embargo total GAFI' },
        { categorie: 'nationalite', valeur: 'iran', points: 90, niveau: 'CRITIQUE', description: 'Iran – sanctions internationales' },
        { categorie: 'nationalite', valeur: 'syria', points: 80, niveau: 'CRITIQUE', description: 'Syrie – zone de conflit actif' },
        { categorie: 'nationalite', valeur: 'afghanistan', points: 70, niveau: 'ELEVE', description: 'Afghanistan – risque blanchiment élevé' },
        { categorie: 'nationalite', valeur: 'default', points: 0, niveau: null, description: 'Nationalité sans surrisque GAFI' },
        // ── Revenus ──────────────────────────────────────────────────────────────
        { categorie: 'revenus', valeur: 'above_500k', points: 20, niveau: 'ELEVE', description: 'Revenus > 500 000 €/an' },
        { categorie: 'revenus', valeur: 'above_100k', points: 10, niveau: 'MOYEN', description: 'Revenus > 100 000 €/an' },
        { categorie: 'revenus', valeur: 'above_50k', points: 5, niveau: 'FAIBLE', description: 'Revenus > 50 000 €/an' },
        { categorie: 'revenus', valeur: 'default', points: 0, niveau: null, description: 'Revenus standards' },
        // ── Âge ──────────────────────────────────────────────────────────────────
        { categorie: 'age', valeur: 'minor', points: 30, niveau: 'ELEVE', description: 'Client mineur – vigilance renforcée' },
        { categorie: 'age', valeur: 'senior', points: 10, niveau: 'FAIBLE', description: 'Client senior (> 80 ans)' },
        { categorie: 'age', valeur: 'default', points: 0, niveau: null, description: 'Tranche d\'âge standard' },
        // ── Moyen de paiement ────────────────────────────────────────────────────
        { categorie: 'paiement', valeur: 'especes', points: 60, niveau: 'CRITIQUE', description: 'Espèces – risque LCB-FT maximal' },
        { categorie: 'paiement', valeur: 'lien_paiement', points: 30, niveau: 'ELEVE', description: 'Lien de paiement – traçabilité réduite' },
        { categorie: 'paiement', valeur: 'cheque', points: 20, niveau: 'MOYEN', description: 'Chèque – risque modéré' },
        { categorie: 'paiement', valeur: 'virement_hors_ue', points: 40, niveau: 'ELEVE', description: 'Virement hors UE/EEE' },
        { categorie: 'paiement', valeur: 'virement', points: 5, niveau: 'FAIBLE', description: 'Virement UE/EEE standard' },
        { categorie: 'paiement', valeur: 'carte', points: 5, niveau: 'FAIBLE', description: 'Carte bancaire' },
        { categorie: 'paiement', valeur: 'default', points: 0, niveau: null, description: 'Paiement standard' },
        // ── Montant de l'opération ───────────────────────────────────────────────
        { categorie: 'montant', valeur: 'above_50k', points: 40, niveau: 'CRITIQUE', description: 'Opération > 50 000 €' },
        { categorie: 'montant', valeur: 'above_20k', points: 30, niveau: 'ELEVE', description: 'Opération > 20 000 €' },
        { categorie: 'montant', valeur: 'above_10k', points: 20, niveau: 'MOYEN', description: 'Opération > 10 000 € (seuil GODECHOT PAULIET)' },
        { categorie: 'montant', valeur: 'above_5k', points: 10, niveau: 'FAIBLE', description: 'Opération > 5 000 €' },
        { categorie: 'montant', valeur: 'default', points: 0, niveau: null, description: 'Opération sous seuil' },
    ];
    await prisma_1.default.facteurRisque.createMany({
        data: facteurs.map(f => ({
            configurationId: config.id,
            categorie: f.categorie,
            valeur: f.valeur,
            points: f.points,
            niveau: f.niveau ?? null,
            description: f.description,
            isActive: true,
        })),
    });
    console.log(`   Created config "${config.nom}" with ${facteurs.length} facteurs.`);
    return config;
}
async function seedAdminUser() {
    console.log('👤  Seeding admin user...');
    const adminEmail = process.env.ADMIN_DEV_EMAIL || 'admin@konfirm.local';
    const adminPassword = process.env.ADMIN_DEV_PASSWORD || 'Konfirm2024!';
    const passwordHash = await bcryptjs_1.default.hash(adminPassword, 12);
    await prisma_1.default.user.upsert({
        where: { email: adminEmail },
        update: {
            passwordHash,
            firstName: 'Admin',
            lastName: 'Konfirm',
            role: 'ADMIN',
            isActive: true,
            isBlocked: false,
            loginAttempts: 0,
            lockedUntil: null,
        },
        create: {
            email: adminEmail,
            passwordHash,
            firstName: 'Admin',
            lastName: 'Konfirm',
            role: 'ADMIN',
            isActive: true,
            isBlocked: false,
            loginAttempts: 0,
        },
    });
    console.log(`   Admin user ready (email: ${adminEmail} / password: ${adminPassword})`);
}
async function seedDefaultConfiguration() {
    console.log('🔧  Seeding default configurations...');
    const configs = [
        { key: 'app.name', value: 'Konfirm', category: 'general', description: "Nom de l'application" },
        { key: 'app.version', value: '1.0.0', category: 'general', description: 'Version courante' },
        { key: 'lcbft.seuil_client', value: 15000, category: 'compliance', description: 'Seuil LCB-FT client occasionnel (€)' },
        { key: 'lcbft.seuil_relation', value: 10000, category: 'compliance', description: 'Seuil LCB-FT relation d\'affaires (€)' },
        { key: 'lcbft.periode_rolling', value: 28, category: 'compliance', description: 'Fenêtre glissante de cumul (jours)' },
        { key: 'dashboard.refresh_ms', value: 30000, category: 'dashboard', description: 'Intervalle de rafraîchissement KPI (ms)' },
    ];
    for (const cfg of configs) {
        await prisma_1.default.configuration.upsert({
            where: { key: cfg.key },
            update: {},
            create: { key: cfg.key, value: cfg.value, category: cfg.category, description: cfg.description },
        });
    }
    console.log(`   ${configs.length} configurations ensured.`);
}
async function seedActivationKeys() {
    console.log('🔑  Seeding activation keys...');
    const keys = [
        {
            code: (process.env.DEFAULT_ACTIVATION_KEY || 'KONFIRM-PRO-MONTHLY-2026').toUpperCase(),
            label: 'Clé PRO Mensuelle',
            plan: 'PRO',
            billingCycle: 'MONTHLY',
            priceCents: 9900,
            seats: 5,
        },
        {
            code: 'KONFIRM-BUSINESS-YEARLY-2026',
            label: 'Clé BUSINESS Annuelle',
            plan: 'BUSINESS',
            billingCycle: 'YEARLY',
            priceCents: 79000,
            seats: 25,
        },
    ];
    for (const key of keys) {
        await prisma_1.default.activationKey.upsert({
            where: { code: key.code },
            update: {},
            create: {
                code: key.code,
                label: key.label,
                plan: key.plan,
                billingCycle: key.billingCycle,
                priceCents: key.priceCents,
                currency: 'EUR',
                seats: key.seats,
                status: 'ACTIVE',
                isRedeemed: false,
            },
        });
    }
    console.log(`   ${keys.length} clés d'activation prêtes.`);
}
async function main() {
    console.log('\n🚀  Starting Konfirm MongoDB seed...\n');
    try {
        await seedScoringConfig();
        await seedAdminUser();
        await seedDefaultConfiguration();
        await seedActivationKeys();
        console.log('\n✅  Seed completed successfully.\n');
    }
    catch (err) {
        console.error('\n❌  Seed failed:', err);
        process.exit(1);
    }
    finally {
        await prisma_1.default.$disconnect();
    }
}
main();
//# sourceMappingURL=index.js.map