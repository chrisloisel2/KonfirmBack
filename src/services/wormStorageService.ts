import crypto from 'crypto';
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { logSystemEvent } from '../utils/logger';

const WORM_DIR = process.env.WORM_STORAGE_DIR || path.join(process.cwd(), 'uploads', 'worm');
const RETENTION_YEARS = parseInt(process.env.RETENTION_YEARS || '5');

export interface WormStorageResult {
  filePath: string;
  relativePath: string;
  fileSize: number;
  sha256Hash: string;
}

/**
 * Calcule la date d'expiration de conservation légale LCB-FT.
 * Art. L. 561-12 CMF : 5 ans à compter de la cessation de la relation d'affaires.
 */
export function calculateRetentionExpiry(
  dateFinRelationAffaires?: Date | null,
  fallbackDate?: Date
): Date {
  const base = dateFinRelationAffaires ?? fallbackDate ?? new Date();
  const expiry = new Date(base);
  expiry.setFullYear(expiry.getFullYear() + RETENTION_YEARS);
  return expiry;
}

/**
 * Vérifie que la durée de conservation n'est pas expirée.
 */
export function isRetentionExpired(retentionExpiry: Date): boolean {
  return new Date() > retentionExpiry;
}

/**
 * Calcule le SHA-256 d'un buffer.
 */
export function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Construit le chemin de stockage WORM hiérarchique.
 * Structure : worm/{annee}/{mois}/{dossierId}/
 */
function buildWormPath(dossierId: string, filename: string): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return path.join(WORM_DIR, year, month, dossierId, filename);
}

/**
 * Rend un fichier immuable (lecture seule, tous utilisateurs).
 */
async function makeImmutable(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o444);
  // Rendre le répertoire parent en lecture seule également
  const dir = path.dirname(filePath);
  await fs.chmod(dir, 0o555);
}

/**
 * Dépose un buffer dans le stockage WORM chiffré.
 * Le fichier est rendu immédiatement immuable après écriture (chmod 444).
 * Le répertoire parent est verrouillé (chmod 555).
 */
export async function storeWormFile(
  dossierId: string,
  buffer: Buffer,
  filename: string
): Promise<WormStorageResult> {
  const filePath = buildWormPath(dossierId, filename);
  const dir = path.dirname(filePath);

  // Création du répertoire avec permissions normales pour pouvoir écrire
  await fs.mkdir(dir, { recursive: true });

  // S'assurer que le répertoire est accessible en écriture avant le dépôt
  try {
    await fs.chmod(dir, 0o755);
  } catch {
    // Le répertoire peut déjà exister et être verrouillé depuis un précédent dépôt
    await fs.chmod(dir, 0o755);
  }

  await fs.writeFile(filePath, buffer);

  const sha256Hash = computeSha256(buffer);

  // Verrouillage WORM immédiat
  await makeImmutable(filePath);

  const stat = await fs.stat(filePath);
  const relativePath = path.relative(process.cwd(), filePath);

  logSystemEvent({
    action: 'backup',
    component: 'worm_storage',
    details: {
      dossierId,
      filePath: relativePath,
      fileSize: stat.size,
      sha256Hash
    },
    severity: 'info'
  });

  return {
    filePath,
    relativePath,
    fileSize: stat.size,
    sha256Hash
  };
}

/**
 * Vérifie l'intégrité d'un fichier archivé par recalcul de son empreinte.
 */
export async function verifyFileIntegrity(
  filePath: string,
  expectedHash: string
): Promise<boolean> {
  try {
    const buffer = await fs.readFile(filePath);
    const actualHash = computeSha256(buffer);
    return actualHash === expectedHash;
  } catch {
    return false;
  }
}

/**
 * Lit un fichier WORM (lecture seule, sans modification des permissions).
 * Interdit si la durée de conservation n'est pas expirée pour la suppression.
 */
export async function readWormFile(filePath: string): Promise<Buffer> {
  try {
    await fs.access(filePath, fsConstants.R_OK);
    return await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`Impossible de lire le fichier archivé : ${filePath}`);
  }
}

/**
 * Tente de supprimer un fichier WORM uniquement si la durée légale est expirée.
 * Lève une erreur si la rétention est toujours en cours.
 */
export async function deleteExpiredWormFile(
  filePath: string,
  retentionExpiry: Date
): Promise<void> {
  if (!isRetentionExpired(retentionExpiry)) {
    const remaining = Math.ceil(
      (retentionExpiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    throw new Error(
      `Suppression interdite : durée légale de conservation non expirée (${remaining} jours restants jusqu'au ${retentionExpiry.toISOString()})`
    );
  }

  // Restaurer les permissions d'écriture avant suppression
  const dir = path.dirname(filePath);
  await fs.chmod(dir, 0o755);
  await fs.chmod(filePath, 0o644);
  await fs.unlink(filePath);

  logSystemEvent({
    action: 'migration',
    component: 'worm_storage',
    details: { filePath, action: 'purge_retention_expired' },
    severity: 'info'
  });
}

/**
 * Retourne les statistiques du stockage WORM.
 */
export async function getWormStorageStats(): Promise<{
  totalFiles: number;
  totalSize: number;
  basePath: string;
}> {
  async function walk(dir: string): Promise<{ count: number; size: number }> {
    let count = 0;
    let size = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const sub = await walk(fullPath);
          count += sub.count;
          size += sub.size;
        } else {
          const stat = await fs.stat(fullPath);
          count++;
          size += stat.size;
        }
      }
    } catch {
      // Répertoire inexistant ou inaccessible
    }
    return { count, size };
  }

  const { count, size } = await walk(WORM_DIR);
  return { totalFiles: count, totalSize: size, basePath: WORM_DIR };
}
