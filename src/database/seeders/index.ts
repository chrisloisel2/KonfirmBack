import prisma from '../../lib/prisma';
import bcrypt from 'bcryptjs';

async function seedScoringConfig() {
  console.log('⚙️  Seeding scoring configuration...');

  const existing = await prisma.configurationScoring.findUnique({ where: { nom: 'default' } });
  if (existing) {
    console.log('   Scoring config already exists, skipping.');
    return existing;
  }

  const config = await prisma.configurationScoring.create({
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
    { categorie: 'profession', valeur: 'politique',  points: 50, niveau: 'CRITIQUE' as const, description: 'Personnalité politique exposée (PPE)' },
    { categorie: 'profession', valeur: 'diplomate',  points: 40, niveau: 'ELEVE'    as const, description: 'Diplomate en poste' },
    { categorie: 'profession', valeur: 'dirigeant',  points: 30, niveau: 'ELEVE'    as const, description: "Dirigeant d'entreprise d'importance" },
    { categorie: 'profession', valeur: 'militaire',  points: 25, niveau: 'MOYEN'    as const, description: 'Haut gradé militaire' },
    { categorie: 'profession', valeur: 'magistrat',  points: 20, niveau: 'MOYEN'    as const, description: 'Magistrat ou fonctionnaire judiciaire' },
    { categorie: 'profession', valeur: 'avocat',     points: 10, niveau: 'FAIBLE'   as const, description: 'Avocat ou conseil juridique' },
    { categorie: 'profession', valeur: 'default',    points:  0, niveau: null,                description: 'Profession sans surrisque identifié' },

    // ── Nationalité (pays GAFI à risque élevé) ───────────────────────────────
    { categorie: 'nationalite', valeur: 'north_korea', points: 100, niveau: 'CRITIQUE' as const, description: 'Corée du Nord – embargo total GAFI' },
    { categorie: 'nationalite', valeur: 'iran',         points:  90, niveau: 'CRITIQUE' as const, description: 'Iran – sanctions internationales' },
    { categorie: 'nationalite', valeur: 'syria',        points:  80, niveau: 'CRITIQUE' as const, description: 'Syrie – zone de conflit actif' },
    { categorie: 'nationalite', valeur: 'afghanistan',  points:  70, niveau: 'ELEVE'    as const, description: 'Afghanistan – risque blanchiment élevé' },
    { categorie: 'nationalite', valeur: 'default',      points:   0, niveau: null,                description: 'Nationalité sans surrisque GAFI' },

    // ── Revenus ──────────────────────────────────────────────────────────────
    { categorie: 'revenus', valeur: 'above_500k', points: 20, niveau: 'ELEVE'  as const, description: 'Revenus > 500 000 €/an' },
    { categorie: 'revenus', valeur: 'above_100k', points: 10, niveau: 'MOYEN'  as const, description: 'Revenus > 100 000 €/an' },
    { categorie: 'revenus', valeur: 'above_50k',  points:  5, niveau: 'FAIBLE' as const, description: 'Revenus > 50 000 €/an' },
    { categorie: 'revenus', valeur: 'default',    points:  0, niveau: null,               description: 'Revenus standards' },

    // ── Âge ──────────────────────────────────────────────────────────────────
    { categorie: 'age', valeur: 'minor',   points: 30, niveau: 'ELEVE'  as const, description: 'Client mineur – vigilance renforcée' },
    { categorie: 'age', valeur: 'senior',  points: 10, niveau: 'FAIBLE' as const, description: 'Client senior (> 80 ans)' },
    { categorie: 'age', valeur: 'default', points:  0, niveau: null,               description: 'Tranche d\'âge standard' },

    // ── Moyen de paiement ────────────────────────────────────────────────────
    { categorie: 'paiement', valeur: 'especes',          points: 60, niveau: 'CRITIQUE' as const, description: 'Espèces – risque LCB-FT maximal' },
    { categorie: 'paiement', valeur: 'lien_paiement',    points: 30, niveau: 'ELEVE'    as const, description: 'Lien de paiement – traçabilité réduite' },
    { categorie: 'paiement', valeur: 'cheque',           points: 20, niveau: 'MOYEN'    as const, description: 'Chèque – risque modéré' },
    { categorie: 'paiement', valeur: 'virement_hors_ue', points: 40, niveau: 'ELEVE'    as const, description: 'Virement hors UE/EEE' },
    { categorie: 'paiement', valeur: 'virement',         points:  5, niveau: 'FAIBLE'   as const, description: 'Virement UE/EEE standard' },
    { categorie: 'paiement', valeur: 'carte',            points:  5, niveau: 'FAIBLE'   as const, description: 'Carte bancaire' },
    { categorie: 'paiement', valeur: 'default',          points:  0, niveau: null,                description: 'Paiement standard' },

    // ── Montant de l'opération ───────────────────────────────────────────────
    { categorie: 'montant', valeur: 'above_50k',  points: 40, niveau: 'CRITIQUE' as const, description: 'Opération > 50 000 €' },
    { categorie: 'montant', valeur: 'above_20k',  points: 30, niveau: 'ELEVE'    as const, description: 'Opération > 20 000 €' },
    { categorie: 'montant', valeur: 'above_10k',  points: 20, niveau: 'MOYEN'    as const, description: 'Opération > 10 000 € (seuil GODECHOT PAULIET)' },
    { categorie: 'montant', valeur: 'above_5k',   points: 10, niveau: 'FAIBLE'   as const, description: 'Opération > 5 000 €' },
    { categorie: 'montant', valeur: 'default',    points:  0, niveau: null,                description: 'Opération sous seuil' },
  ];

  await prisma.facteurRisque.createMany({
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
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await prisma.user.upsert({
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

async function seedDemoAccounts() {
  console.log('👥  Seeding 10 demo accounts...');

  const defaultPassword = 'Demo2026!';
  const passwordHash = await bcrypt.hash(defaultPassword, 12);

  const accounts = [
    { firstName: 'Sophie',    lastName: 'Martin',    email: 'sophie.martin@demo.konfirm.local',    role: 'RESPONSABLE' as const },
    { firstName: 'Thomas',    lastName: 'Bernard',   email: 'thomas.bernard@demo.konfirm.local',   role: 'REFERENT'    as const },
    { firstName: 'Claire',    lastName: 'Dubois',    email: 'claire.dubois@demo.konfirm.local',    role: 'CONSEILLER'  as const },
    { firstName: 'Antoine',   lastName: 'Leroy',     email: 'antoine.leroy@demo.konfirm.local',    role: 'CONSEILLER'  as const },
    { firstName: 'Lea',       lastName: 'Moreau',    email: 'lea.moreau@demo.konfirm.local',       role: 'CAISSE'      as const },
    { firstName: 'Nicolas',   lastName: 'Simon',     email: 'nicolas.simon@demo.konfirm.local',    role: 'CAISSE'      as const },
    { firstName: 'Camille',   lastName: 'Laurent',   email: 'camille.laurent@demo.konfirm.local',  role: 'CONSEILLER'  as const },
    { firstName: 'Julien',    lastName: 'Petit',     email: 'julien.petit@demo.konfirm.local',     role: 'REFERENT'    as const },
    { firstName: 'Margaux',   lastName: 'Robert',    email: 'margaux.robert@demo.konfirm.local',   role: 'CONSEILLER'  as const },
    { firstName: 'Alexandre', lastName: 'Garnier',   email: 'alexandre.garnier@demo.konfirm.local',role: 'RESPONSABLE' as const },
  ];

  for (const account of accounts) {
    await prisma.user.upsert({
      where: { email: account.email },
      update: { passwordHash, isActive: true },
      create: {
        ...account,
        passwordHash,
        isActive: true,
        isBlocked: false,
        loginAttempts: 0,
      },
    });
    console.log(`   ${account.role.padEnd(12)} — ${account.firstName} ${account.lastName} <${account.email}>`);
  }

  console.log(`\n   All 10 accounts use password: ${defaultPassword}`);
}

async function seedDefaultConfiguration() {
  console.log('🔧  Seeding default configurations...');

  const configs = [
    { key: 'app.name',               value: 'Konfirm',      category: 'general',     description: "Nom de l'application" },
    { key: 'app.version',            value: '1.0.0',        category: 'general',     description: 'Version courante' },
    { key: 'lcbft.seuil_client',     value: 15000,          category: 'compliance',  description: 'Seuil LCB-FT client occasionnel (€)' },
    { key: 'lcbft.seuil_relation',   value: 10000,          category: 'compliance',  description: 'Seuil LCB-FT relation d\'affaires (€)' },
    { key: 'lcbft.periode_rolling',  value: 28,             category: 'compliance',  description: 'Fenêtre glissante de cumul (jours)' },
    { key: 'dashboard.refresh_ms',   value: 30000,          category: 'dashboard',   description: 'Intervalle de rafraîchissement KPI (ms)' },
  ];

  for (const cfg of configs) {
    await prisma.configuration.upsert({
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
    await (prisma as any).activationKey.upsert({
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

async function seedResponsableWithCompany() {
  console.log('🏢  Seeding Responsable account with company & subscription...');

  const email      = (process.env.RESPONSABLE_EMAIL    || 'responsable@konfirm.local').toLowerCase();
  const password   = process.env.RESPONSABLE_PASSWORD  || 'Responsable2026!';
  const companyName = process.env.RESPONSABLE_COMPANY  || 'Ma Société';

  // ── Company ──────────────────────────────────────────────────────────────────
  let company = await prisma.company.findFirst({ where: { name: companyName } });
  if (!company) {
    company = await prisma.company.create({
      data: { name: companyName },
    });
    console.log(`   Company created: "${companyName}" (id: ${company.id})`);
  } else {
    console.log(`   Company already exists: "${companyName}" (id: ${company.id})`);
  }

  // ── Subscription ─────────────────────────────────────────────────────────────
  const existingSub = await prisma.subscription.findUnique({ where: { companyId: company.id } });
  if (!existingSub) {
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    await prisma.subscription.create({
      data: {
        companyId:   company.id,
        plan:        'BUSINESS',
        status:      'ACTIVE',
        maxAccounts: 10,
        maxShops:    5,
        features:    ['dossiers', 'ocr', 'scoring', 'exceptions', 'recherches', 'watchlists', 'intelligence'],
        startDate:   new Date(),
        expiresAt,
      },
    });
    console.log(`   Subscription BUSINESS/ACTIVE created (expires: ${expiresAt.toLocaleDateString('fr-FR')})`);
  } else {
    console.log(`   Subscription already exists (status: ${existingSub.status})`);
  }

  // ── Responsable user ─────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      companyId: company.id,
      role: 'RESPONSABLE',
      isActive: true,
      isBlocked: false,
      loginAttempts: 0,
      lockedUntil: null,
    },
    create: {
      email,
      passwordHash,
      firstName: 'Responsable',
      lastName:  'Principal',
      role:      'RESPONSABLE',
      companyId: company.id,
      isActive:  true,
      isBlocked: false,
      loginAttempts: 0,
    },
  });

  console.log(`\n   ┌─────────────────────────────────────────────────────`);
  console.log(`   │  Compte RESPONSABLE prêt`);
  console.log(`   │  Email    : ${email}`);
  console.log(`   │  Password : ${password}`);
  console.log(`   │  Société  : ${companyName}`);
  console.log(`   │  Plan     : BUSINESS — 10 comptes, 5 sites physiques`);
  console.log(`   └─────────────────────────────────────────────────────`);
  console.log(`\n   Ce compte peut maintenant :`);
  console.log(`     → Créer des sites physiques  : POST /api/settings/shops`);
  console.log(`     → Créer des comptes (CAISSE, REFERENT…) : POST /api/settings/accounts`);
  console.log(`     → Assigner des utilisateurs à des sites via shopIds`);

  return user;
}

async function main() {
  console.log('\n🚀  Starting Konfirm MongoDB seed...\n');
  try {
    await seedScoringConfig();
    await seedAdminUser();
    await seedDemoAccounts();
    await seedDefaultConfiguration();
    await seedActivationKeys();
    await seedResponsableWithCompany();
    console.log('\n✅  Seed completed successfully.\n');
  } catch (err) {
    console.error('\n❌  Seed failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
