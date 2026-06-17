import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_DEFAULT_DB_PATH = resolve(__dirname, '../default_database');
const GOOGLE_STATS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwahqGocPhBwCTaB2HjnM3WIjoTOoc-lk94i8JjkRaTfEXf-rT-OXe0pkpQkZk5u0Tm/exec';
const CACHE_DIR = resolve(__dirname, '.cache');
const GOOGLE_CACHE_PATH = resolve(CACHE_DIR, 'google_database.json');
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

function normalizeDatabase(parsed, sourceLabel) {
  const db = parsed && typeof parsed === 'object' ? parsed : {};
  const players = Array.isArray(db.players) ? db.players : [];
  const games = Array.isArray(db.games) ? db.games : [];
  return { db, players, games, sourceLabel };
}

function loadDatabaseFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return normalizeDatabase(parsed, path);
}

function isTruthyEnv(value) {
  return /^(1|true|yes|refresh)$/i.test(String(value || '').trim());
}

function getCacheTtlMs() {
  const raw = Number(process.env.VBALL_DB_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

function readGoogleCache() {
  if (!existsSync(GOOGLE_CACHE_PATH)) return null;

  const cache = JSON.parse(readFileSync(GOOGLE_CACHE_PATH, 'utf8'));
  const fetchedAt = Number(cache?.fetchedAt) || 0;
  const ageMs = Date.now() - fetchedAt;
  if (ageMs < 0 || ageMs > getCacheTtlMs()) return null;
  if (!cache?.database || typeof cache.database !== 'object') return null;

  return normalizeDatabase(cache.database, `${cache.sourceLabel || 'Google Drive'} cached`);
}

function writeGoogleCache(loaded) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    GOOGLE_CACHE_PATH,
    JSON.stringify({
      fetchedAt: Date.now(),
      sourceLabel: loaded.sourceLabel,
      database: loaded.db,
    }),
    'utf8'
  );
}

async function fetchGoogleDatabase() {
  const response = await fetch(GOOGLE_STATS_ENDPOINT, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Google stats returned HTTP ${response.status}`);
  }

  const parsed = await response.json();
  if (!parsed || typeof parsed !== 'object' || parsed.ok === false) {
    throw new Error(parsed?.error || 'Google stats response was invalid');
  }

  const sourceFileName = parsed.source?.fileName ? ` (${parsed.source.fileName})` : '';
  return normalizeDatabase(parsed, `Google Drive${sourceFileName}`);
}

export async function loadDatabase() {
  if (process.env.VBALL_DB) {
    const loaded = loadDatabaseFile(process.env.VBALL_DB);
    console.error(`[eval] database: ${loaded.sourceLabel}`);
    return loaded;
  }

  try {
    if (!isTruthyEnv(process.env.VBALL_DB_REFRESH)) {
      const cached = readGoogleCache();
      if (cached) {
        console.error(`[eval] database: ${cached.sourceLabel}`);
        return cached;
      }
    }

    const loaded = await fetchGoogleDatabase();
    writeGoogleCache(loaded);
    console.error(`[eval] database: ${loaded.sourceLabel}`);
    return loaded;
  } catch (error) {
    try {
      const cached = readGoogleCache();
      if (cached) {
        console.error(`[eval] database: ${cached.sourceLabel} (Google fetch failed: ${error.message})`);
        return cached;
      }
    } catch {
      // Fall through to the bundled local database.
    }

    const loaded = loadDatabaseFile(LOCAL_DEFAULT_DB_PATH);
    console.error(`[eval] database: ${loaded.sourceLabel} (Google fetch failed: ${error.message})`);
    return loaded;
  }
}
