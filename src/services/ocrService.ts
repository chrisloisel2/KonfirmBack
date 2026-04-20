import fs from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import Tesseract from 'tesseract.js';
import { parse as parseMRZ } from 'mrz';
import sharp from 'sharp';
import { logSystemEvent } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IdentityData {
  nom: string;
  prenom: string;
  dateNaissance: string;   // DD/MM/YYYY
  nationalite: string;
  numeroDocument: string;
  dateExpiration: string;  // DD/MM/YYYY
  sexe?: string;
  lieuNaissance?: string;
  confidence: number;      // 0–1
  source: 'mindee' | 'tesseract_mrz' | 'tesseract_text';
  mrzValid?: boolean;
  raw?: any;
}

interface Variant { p: string; mrzCrop: boolean; }

function createOcrLogger(component: string) {
  return (msg: { status?: string; progress?: number }) => {
    if (typeof msg?.progress !== 'number') return;
    logSystemEvent({
      action: 'ocr_progress',
      component,
      details: { progress: msg.progress },
      severity: 'info',
    });
  };
}

async function createInitializedWorker(component: string, langs = 'fra+eng') {
  const worker = await Tesseract.createWorker({
    logger: createOcrLogger(component),
    errorHandler: (error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
  });

  await worker.loadLanguage(langs);
  await worker.initialize(langs);
  return worker;
}

// ─── Check digit ──────────────────────────────────────────────────────────────

const CK_W = [7, 3, 1];

function charVal(c: string): number {
  if (c === '<') return 0;
  const n = c.charCodeAt(0);
  if (n >= 48 && n <= 57) return n - 48;
  if (n >= 65 && n <= 90) return n - 55;
  return -1;
}

function calcCheck(s: string): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const v = charVal(s[i]);
    if (v < 0) return -1;
    sum += v * CK_W[i % 3];
  }
  return sum % 10;
}

function checkOk(value: string, digit: string): boolean {
  const d = parseInt(digit, 10);
  return !isNaN(d) && calcCheck(value) === d;
}

// ─── OCR error correction tables ──────────────────────────────────────────────

// Characters that look like digits but are letters, and vice-versa
const ALPHA_TO_DIGIT: Record<string, string> = {
  O: '0', Q: '0', D: '0',
  I: '1', L: '1',
  Z: '2',
  B: '8',
  S: '5',
  G: '6',
  T: '7',
};
const DIGIT_TO_ALPHA: Record<string, string> = {
  '0': 'O', '1': 'I', '8': 'B', '5': 'S', '2': 'Z',
};

type PosType = 'D' | 'A' | 'X';

// TD3 passport, line 2 (44 chars): position semantic types
const TD3L2: PosType[] = [
  // 0-8: document number (alphanumeric)
  'X','X','X','X','X','X','X','X','X',
  'D',              // 9: check digit
  'A','A','A',      // 10-12: nationality
  'D','D','D','D','D','D', // 13-18: birth date
  'D',              // 19: check digit
  'A',              // 20: sex
  'D','D','D','D','D','D', // 21-26: expiry date
  'D',              // 27: check digit
  'X','X','X','X','X','X','X','X','X','X','X','X','X','X', // 28-41: personal
  'D','D',          // 42-43: check digits
];

// TD1 CNI, line 2 (30 chars)
const TD1L2: PosType[] = [
  'D','D','D','D','D','D', // 0-5: birth date
  'D',              // 6: check
  'A',              // 7: sex
  'D','D','D','D','D','D', // 8-13: expiry
  'D',              // 14: check
  'X','X','X',      // 15-17: nationality
  'X','X','X','X','X','X','X','X','X','X','X', // 18-28: optional
  'D',              // 29: composite check
];

function coerceMRZChar(raw: string, type: PosType): string {
  const u = raw.toUpperCase();
  // Normalize to valid MRZ set first
  const clean = /^[A-Z0-9<]$/.test(u) ? u
    : (raw === ' ' || raw === '_' || raw === '-') ? '<'
    : ALPHA_TO_DIGIT[u] !== undefined ? u  // keep; will correct below
    : '<';

  if (type === 'D') {
    if (/^[0-9]$/.test(clean)) return clean;
    return ALPHA_TO_DIGIT[clean] ?? clean;
  }
  if (type === 'A') {
    if (/^[A-Z<]$/.test(clean)) return clean;
    return DIGIT_TO_ALPHA[clean] ?? clean;
  }
  return /^[A-Z0-9<]$/.test(clean) ? clean : '<';
}

function fixLine(raw: string, schema: PosType[]): string {
  return raw.split('').map((c, i) => coerceMRZChar(c, schema[i] ?? 'X')).join('');
}

// ─── Image preprocessing ──────────────────────────────────────────────────────

async function buildVariants(src: string): Promise<{ variants: Variant[]; base: string }> {
  // Rotate using EXIF first → write temp file so all variants share same geometry
  const base = path.join(os.tmpdir(), `ocr_${Date.now()}`);
  const rotated = `${base}_rot.jpg`;
  await sharp(src).rotate().jpeg({ quality: 95 }).toFile(rotated);

  const meta = await sharp(rotated).metadata();
  const W = 2400;
  const h = meta.height ?? 1700;
  const w = meta.width ?? 1200;
  const variants: Variant[] = [];

  const write = async (pipeline: sharp.Sharp, label: string, mrzCrop: boolean) => {
    const p = `${base}_${label}.jpg`;
    await pipeline.jpeg({ quality: 95 }).toFile(p);
    variants.push({ p, mrzCrop });
  };

  // Full-page variants
  await write(sharp(rotated).resize({ width: W }).greyscale().normalize().sharpen(), 'std', false);
  await write(sharp(rotated).resize({ width: W }).greyscale().gamma(1.8).normalize().sharpen({ sigma: 2 }), 'hicon', false);
  await write(sharp(rotated).resize({ width: W }).greyscale().normalize().threshold(128), 'thresh', false);

  // MRZ-crop variants (bottom 42% of document)
  if (h > 400) {
    const cropTop = Math.floor(h * 0.58);
    const cropH = h - cropTop;
    await write(sharp(rotated).extract({ left: 0, top: cropTop, width: w, height: cropH }).resize({ width: W }).greyscale().normalize().sharpen(), 'mrz_std', true);
    await write(sharp(rotated).extract({ left: 0, top: cropTop, width: w, height: cropH }).resize({ width: W }).greyscale().gamma(1.8).normalize().sharpen({ sigma: 2 }), 'mrz_hicon', true);
    await write(sharp(rotated).extract({ left: 0, top: cropTop, width: w, height: cropH }).resize({ width: W }).greyscale().normalize().threshold(135), 'mrz_thresh', true);
  }

  return { variants, base };
}

// ─── MRZ line extraction from raw OCR text ────────────────────────────────────

function normLine(line: string, target: number): string {
  if (line.length === target) return line;
  if (line.length < target) return line.padEnd(target, '<');
  return line.slice(0, target);
}

function extractMRZLines(text: string): string[] {
  const candidates = text
    .split('\n')
    .map(l => l.replace(/\s/g, '').toUpperCase().replace(/[^A-Z0-9<]/g, ''))
    .filter(l => l.length >= 26);

  // TD3 passport: 2 × 44
  const td3 = candidates.filter(l => Math.abs(l.length - 44) <= 5);
  if (td3.length >= 2) return td3.slice(0, 2).map(l => normLine(l, 44));

  // TD1 French CNI: 3 × 30
  const td1 = candidates.filter(l => Math.abs(l.length - 30) <= 5);
  if (td1.length >= 3) return td1.slice(0, 3).map(l => normLine(l, 30));
  if (td1.length === 2) return td1.map(l => normLine(l, 30));

  // TD2 old CNI: 2 × 36
  const td2 = candidates.filter(l => Math.abs(l.length - 36) <= 5);
  if (td2.length >= 2) return td2.slice(0, 2).map(l => normLine(l, 36));

  // Last resort: two longest
  if (candidates.length >= 2) {
    const sorted = [...candidates].sort((a, b) => b.length - a.length);
    return sorted.slice(0, 2).map(l => normLine(l, 44));
  }
  return [];
}

// ─── MRZ parsing with check-digit validation and correction ───────────────────

function scoreMRZResult(result: any): { score: number; valid: boolean } {
  if (!result || (!result.fields?.lastName && !result.fields?.firstName)) {
    return { score: 0, valid: false };
  }
  let valid = false;
  let checks = 0;
  if (Array.isArray(result.details)) {
    for (const d of result.details) {
      if (d.valid) checks++;
    }
    valid = result.valid === true;
  }
  const score = (valid ? 50 : 0) + checks * 10;
  return { score, valid };
}

function tryParseMRZLines(lines: string[]): IdentityData | null {
  if (lines.length < 2) return null;

  // Build correction attempts
  const attempts: string[][] = [lines]; // raw
  if (lines.length === 2 && lines[1].length === 44) {
    const fixed = [lines[0], fixLine(lines[1], TD3L2)];
    if (fixed[1] !== lines[1]) attempts.push(fixed);
  }
  if (lines.length >= 2 && lines[1].length === 30) {
    const fixed = [lines[0], fixLine(lines[1], TD1L2), lines[2] ?? ''];
    if (fixed[1] !== lines[1]) attempts.push(fixed.filter(Boolean));
  }

  let best: any = null;
  let bestScore = -1;

  for (const attempt of attempts) {
    try {
      const result = parseMRZ(attempt);
      const { score } = scoreMRZResult(result);
      if (score > bestScore) {
        bestScore = score;
        best = { result, lines: attempt };
      }
    } catch { /* invalid MRZ format */ }
  }

  if (!best || bestScore <= 0) return null;

  const { result, lines: usedLines } = best;
  const { valid } = scoreMRZResult(result);
  const f = result.fields;

  const nom    = (f.lastName  ?? '').replace(/</g, ' ').trim();
  const prenom = (f.firstName ?? '').replace(/</g, ' ').trim();
  if (!nom && !prenom) return null;

  return {
    nom:            nom.toUpperCase(),
    prenom:         capitalize(prenom),
    dateNaissance:  mrzDateToFr(f.birthDate ?? ''),
    nationalite:    f.nationality === 'FRA' ? 'Française' : (f.nationality ?? ''),
    numeroDocument: (f.documentNumber ?? '').replace(/<+$/, ''),
    dateExpiration: mrzDateToFr(f.expirationDate ?? ''),
    sexe:           f.sex ?? undefined,
    confidence:     valid ? 0.97 : Math.max(0.6, bestScore / 100),
    source:         'tesseract_mrz',
    mrzValid:       valid,
    raw:            { result, lines: usedLines },
  };
}

// ─── Text-based field extraction ──────────────────────────────────────────────

function extractFromRawText(text: string, ocrConfidence: number): IdentityData | null {
  const NOISE = /[^A-Za-z0-9\s\/\.\,\-àâéèêëîïôùûüçÀÂÉÈÊËÎÏÔÙÛÜÇ]/g;
  const clean = (s: string) => s.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  const lines = text.split('\n').map(clean).filter(Boolean);
  const blob  = lines.join('\n');

  // ── Nom ──────────────────────────────────────────────────────────────────────
  let nom = '';
  let prenom = '';

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!nom && /\bNOM\b/i.test(l) && !/PRENOM|DOCU/i.test(l)) {
      const m = l.match(/\bNOM\b\s*[°:.,\-]?\s+([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ]{2,}(?:[- ][A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ]+)*)/i);
      if (m) { nom = m[1]; }
      else if (lines[i + 1]) {
        const v = lines[i + 1].match(/([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ]{2,}(?:[- ][A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ]+)*)/);
        if (v && !/PRENOM|CARTE|NATIONALE/i.test(v[1])) nom = v[1];
      }
    }
    if (!prenom && /PR[EÉ]NOM/i.test(l)) {
      const after = l.replace(/.*?PR[EÉ]NOM/i, '').replace(/[^A-Za-zÀ-ÿ\s\-]/g, ' ');
      const words = after.split(/\s+/).filter(w => w.length >= 2 && /^[A-Za-zÀ-ÿ\-]+$/.test(w));
      if (words.length > 0) prenom = words.join(' ');
      else if (lines[i + 1]) prenom = lines[i + 1].split(/\s+/).filter(w => /^[A-Za-zÀ-ÿ\-]{2,}$/.test(w)).join(' ');
    }
  }

  // ── Dates ─────────────────────────────────────────────────────────────────
  const dateRx = /(\d{2})[\/\.\s]?(\d{2})[\/\.\s]?(\d{4})/g;
  const dates: string[] = [];
  let dm: RegExpExecArray | null;
  while ((dm = dateRx.exec(blob)) !== null) {
    const [, dd, mm, yyyy] = dm;
    const y = parseInt(yyyy);
    if (+mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31 && y >= 1900 && y <= 2100)
      dates.push(`${dd}/${mm}/${yyyy}`);
  }
  const uniq = [...new Set(dates)];
  const nowY = new Date().getFullYear();
  const dateNaissance  = uniq.find(d => +d.split('/')[2] < nowY - 5) ?? uniq[0] ?? '';
  const dateExpiration = uniq.find(d => +d.split('/')[2] >= nowY)    ?? uniq.at(-1) ?? '';

  // ── Document number ────────────────────────────────────────────────────────
  const SKIP = /^(?:NATIONALE|REPUBLIQUE|FRANCAISE|FRANÇAISE|DOCUMENT|IDENTITY|PASSEPORT|INVALIDE)/i;
  let docNum = blob.match(/\b(\d{12})\b/)?.[1]
    ?? blob.match(/\b([A-Z]{2}[0-9]{7,9})\b/)?.[1]
    ?? '';
  if (!docNum) {
    const mx = /\b([A-Z][A-Z0-9]{7,11})\b/g;
    let mm2: RegExpExecArray | null;
    while ((mm2 = mx.exec(blob)) !== null) {
      if (!SKIP.test(mm2[1])) { docNum = mm2[1]; break; }
    }
  }

  // ── Lieu de naissance ──────────────────────────────────────────────────────
  const lieu = blob.match(/(?:n[ée]+?e?)\s+[àa]\s+([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ][A-Za-zÀ-ÿ\s\-]{2,25}?)(?:\s{2,}|\n|$)/i)?.[1]?.trim();

  if (!nom && !prenom) return null;

  return {
    nom:            nom.toUpperCase(),
    prenom:         capitalize(prenom),
    dateNaissance,
    nationalite:    /fran[çc]ais/i.test(blob) ? 'Française' : '',
    numeroDocument: docNum,
    dateExpiration,
    lieuNaissance:  lieu,
    confidence:     Math.max(0.2, ocrConfidence * 0.55),
    source:         'tesseract_text',
    mrzValid:       false,
  };
}

// ─── Result selection ─────────────────────────────────────────────────────────

function fieldScore(d: IdentityData): number {
  return (d.nom.length > 1 ? 30 : 0)
    + (d.prenom.length > 1 ? 20 : 0)
    + (d.dateNaissance.length === 10 ? 20 : 0)
    + (d.numeroDocument.length >= 5 ? 20 : 0)
    + (d.dateExpiration.length === 10 ? 10 : 0);
}

function pickBest(candidates: IdentityData[]): IdentityData | null {
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => {
    const mrzA = a.mrzValid ? 1 : 0;
    const mrzB = b.mrzValid ? 1 : 0;
    if (mrzA !== mrzB) return mrzB - mrzA;
    const sA = fieldScore(a) * a.confidence;
    const sB = fieldScore(b) * b.confidence;
    return sB - sA;
  })[0];
}

// ─── PDF → image ──────────────────────────────────────────────────────────────

async function pdfToImage(pdfPath: string): Promise<string | null> {
  const prefix = path.join(os.tmpdir(), `pdf_${Date.now()}`);

  // Try pdftoppm (poppler-utils)
  try {
    execSync(`pdftoppm -r 300 -f 1 -l 1 -jpeg "${pdfPath}" "${prefix}"`, { stdio: 'ignore', timeout: 30_000 });
    for (const suf of ['-1.jpg', '-01.jpg', '-001.jpg']) {
      try { await fs.access(prefix + suf); return prefix + suf; } catch { /* try next */ }
    }
  } catch { /* pdftoppm not available */ }

  // Try ghostscript
  try {
    const out = `${prefix}.jpg`;
    execSync(`gs -dNOPAUSE -dBATCH -dFirstPage=1 -dLastPage=1 -sDEVICE=jpeg -r300 -sOutputFile="${out}" "${pdfPath}"`, { stdio: 'ignore', timeout: 30_000 });
    await fs.access(out);
    return out;
  } catch { /* gs not available */ }

  // Try ImageMagick
  try {
    const out = `${prefix}.jpg`;
    execSync(`convert -density 300 "${pdfPath}[0]" "${out}"`, { stdio: 'ignore', timeout: 30_000 });
    await fs.access(out);
    return out;
  } catch { /* convert not available */ }

  return null;
}

// ─── Mindee ───────────────────────────────────────────────────────────────────

async function extractWithMindee(imagePath: string, docType: 'cni' | 'passeport'): Promise<IdentityData | null> {
  const apiKey = process.env.MINDEE_API_KEY;
  if (!apiKey) return null;

  try {
    const { v1 } = await import('mindee') as any;
    const client = new v1.Client({ apiKey });
    const inputSource = client.docFromPath(imagePath);
    const response = await client.parse(
      docType === 'passeport' ? v1.product.PassportV1 : v1.product.fr.IdCardV2,
      inputSource,
    );
    const doc = response.document.inference.prediction;
    const nom      = doc.surname?.value ?? '';
    const prenoms  = Array.isArray(doc.givenNames)
      ? doc.givenNames.map((g: any) => g.value ?? '').join(' ')
      : (doc.givenNames?.value ?? '');
    const docNumber = doc.documentNumber?.value ?? doc.idNumber?.value ?? '';
    if (!nom && !prenoms && !docNumber) return null;

    return {
      nom:            nom.toUpperCase(),
      prenom:         capitalize(prenoms),
      dateNaissance:  isoToFr(doc.birthDate?.value ?? ''),
      nationalite:    doc.nationality?.value === 'FRA' ? 'Française' : (doc.nationality?.value ?? ''),
      numeroDocument: docNumber,
      dateExpiration: isoToFr(doc.expiryDate?.value ?? ''),
      sexe:           doc.gender?.value ?? undefined,
      confidence:     0.97,
      source:         'mindee',
      mrzValid:       true,
      raw:            doc,
    };
  } catch (err) {
    logSystemEvent({ action: 'ocr_error', component: 'mindee', details: { error: String(err) }, severity: 'warning' });
    return null;
  }
}

// ─── Tesseract multi-pipeline ─────────────────────────────────────────────────

async function extractWithTesseract(imagePath: string, isPdf: boolean): Promise<IdentityData | null> {
  // For PDFs: try to convert first page to image
  let workPath = imagePath;
  let pdfImgPath: string | null = null;
  if (isPdf) {
    pdfImgPath = await pdfToImage(imagePath);
    if (pdfImgPath) { workPath = pdfImgPath; }
    else {
      // Born-digital PDF: extract text via pdf-parse
      try {
        const pdfParse = (await import('pdf-parse')).default;
        const buf = await fs.readFile(imagePath);
        const { text } = await pdfParse(buf);
        if (text) {
          const lines = extractMRZLines(text);
          if (lines.length >= 2) {
            const mrzResult = tryParseMRZLines(lines);
            if (mrzResult) return mrzResult;
          }
        }
      } catch { /* ignore */ }
      return null;
    }
  }

  const { variants, base } = await buildVariants(workPath);
  const tmpFiles = [
    `${base}_rot.jpg`,
    ...variants.map(v => v.p),
    ...(pdfImgPath ? [pdfImgPath] : []),
  ];

  const mrzWorker = await createInitializedWorker('tesseract_mrz');
  const txtWorker = await createInitializedWorker('tesseract_text');

  try {
    await Promise.all([
      mrzWorker.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
        tessedit_pageseg_mode: '6' as any,
      } as any),
      txtWorker.setParameters({
        tessedit_pageseg_mode: '11' as any,
      } as any),
    ]);

    const candidates: IdentityData[] = [];
    const addIfBetter = (d: IdentityData | null) => { if (d) candidates.push(d); };

    // ── Phase 1: MRZ worker on MRZ-cropped variants (fastest path) ──────────
    for (const v of variants.filter(v => v.mrzCrop)) {
      const { data } = await mrzWorker.recognize(v.p);
      const lines = extractMRZLines(data.text);
      if (lines.length >= 2) {
        const parsed = tryParseMRZLines(lines);
        addIfBetter(parsed);
        if (parsed?.mrzValid && parsed.confidence >= 0.95) return parsed; // early exit
      }
    }

    // ── Phase 2: MRZ worker on full-page variants ────────────────────────────
    for (const v of variants.filter(v => !v.mrzCrop)) {
      const { data } = await mrzWorker.recognize(v.p);
      const lines = extractMRZLines(data.text);
      if (lines.length >= 2) {
        const parsed = tryParseMRZLines(lines);
        addIfBetter(parsed);
        if (parsed?.mrzValid && parsed.confidence >= 0.95) return parsed;
      }
    }

    // ── Phase 3: Full-text extraction on all variants ────────────────────────
    for (const v of variants) {
      const { data } = await txtWorker.recognize(v.p);
      addIfBetter(extractFromRawText(data.text, data.confidence / 100));
    }

    // ── Phase 4: Rotation fallback if nothing found ──────────────────────────
    const hasGoodResult = candidates.some(c => c.mrzValid || fieldScore(c) >= 50);
    if (!hasGoodResult) {
      const rotBase = path.join(os.tmpdir(), `ocr_rot_${Date.now()}`);
      for (const deg of [90, 180, 270]) {
        const rotPath = `${rotBase}_${deg}.jpg`;
        try {
          await sharp(workPath).rotate(deg).jpeg({ quality: 95 }).toFile(rotPath);
          tmpFiles.push(rotPath);
          const { data } = await mrzWorker.recognize(rotPath);
          const lines = extractMRZLines(data.text);
          if (lines.length >= 2) {
            const parsed = tryParseMRZLines(lines);
            addIfBetter(parsed);
            if (parsed?.mrzValid) return parsed;
          }
        } catch { /* skip this rotation */ }
      }
    }

    return pickBest(candidates);
  } finally {
    await Promise.allSettled([mrzWorker.terminate(), txtWorker.terminate()]);
    await Promise.allSettled(tmpFiles.map(f => fs.unlink(f)));
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractIdentityData(
  imagePath: string,
  docType: 'cni' | 'passeport' = 'cni',
): Promise<IdentityData> {
  const ext = path.extname(imagePath).toLowerCase();
  const isPdf = ext === '.pdf';

  logSystemEvent({
    action: 'ocr_start',
    component: 'ocrService',
    details: { docType, file: path.basename(imagePath), isPdf },
    severity: 'info',
  });

  // 1. Mindee (commercial, ~97% accuracy, no preprocessing needed)
  if (process.env.MINDEE_API_KEY) {
    const result = await extractWithMindee(imagePath, docType);
    if (result) {
      logSystemEvent({ action: 'ocr_done', component: 'ocrService', details: { source: 'mindee', confidence: result.confidence }, severity: 'info' });
      return result;
    }
  }

  // 2. Multi-pipeline Tesseract
  try {
    const result = await extractWithTesseract(imagePath, isPdf);
    if (result) {
      logSystemEvent({ action: 'ocr_done', component: 'ocrService', details: { source: result.source, confidence: result.confidence, mrzValid: result.mrzValid }, severity: 'info' });
      return result;
    }
  } catch (error) {
    logSystemEvent({
      action: 'ocr_error',
      component: 'ocrService',
      details: {
        stage: 'tesseract',
        error: error instanceof Error ? error.message : String(error),
        docType,
        file: path.basename(imagePath),
      },
      severity: 'error',
    });
  }

  logSystemEvent({ action: 'ocr_failed', component: 'ocrService', details: { docType }, severity: 'warning' });
  return { nom: '', prenom: '', dateNaissance: '', nationalite: '', numeroDocument: '', dateExpiration: '', confidence: 0, source: 'tesseract_text' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoToFr(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function mrzDateToFr(d: string): string {
  if (!d || d.length !== 6) return '';
  const yy = parseInt(d.slice(0, 2), 10);
  const mm = d.slice(2, 4);
  const dd = d.slice(4, 6);
  const cy = new Date().getFullYear() % 100;
  const century = yy > cy + 10 ? 1900 : 2000;
  return `${dd}/${mm}/${century + yy}`;
}

function capitalize(s: string): string {
  return s.toLowerCase().replace(/(?:^|\s|-)[a-zàâéèêëîïôùûüç]/g, c => c.toUpperCase());
}
