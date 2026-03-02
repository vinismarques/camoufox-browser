import os from 'node:os';
import path from 'node:path';

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseIntSafe(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

export function loadConfig() {
  const dataDir = env('BROWSER_RUNTIME_DATA_DIR', path.join(os.homedir(), '.cache', 'camoufox-browser'));

  return {
    port: parseIntSafe(env('BROWSER_RUNTIME_PORT', process.env.PORT), 9487),
    host: env('BROWSER_RUNTIME_HOST', '127.0.0.1'),
    nodeEnv: env('NODE_ENV', 'development'),

    headless: parseBool(env('CAMOUFOX_HEADLESS'), false),
    os: env('CAMOUFOX_OS', hostOS()),
    humanize: parseBool(env('CAMOUFOX_HUMANIZE'), true),
    enableCache: parseBool(env('CAMOUFOX_ENABLE_CACHE'), true),

    sessionTimeoutMs: parseIntSafe(env('SESSION_TIMEOUT_MS'), 24 * 60 * 60 * 1000),
    tabActionTimeoutMs: parseIntSafe(env('TAB_ACTION_TIMEOUT_MS'), 30000),
    maxSnapshotChars: parseIntSafe(env('MAX_SNAPSHOT_CHARS'), 120000),
    maxDomChars: parseIntSafe(env('MAX_DOM_CHARS'), 220000),
    maxDomFallbackRefs: parseIntSafe(env('MAX_DOM_FALLBACK_REFS'), 240),
    maxEventsPerTab: parseIntSafe(env('MAX_EVENTS_PER_TAB'), 5000),
    captureResponseBodies: parseBool(env('CAPTURE_RESPONSE_BODIES'), false),
    maxCapturedBodyBytes: parseIntSafe(env('MAX_CAPTURED_BODY_BYTES'), 256 * 1024),

    dataDir,
    profilesDir: path.join(dataDir, 'profiles'),
    artifactsDir: path.join(dataDir, 'artifacts'),
    logsDir: path.join(dataDir, 'logs')
  };
}

function hostOS() {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}
