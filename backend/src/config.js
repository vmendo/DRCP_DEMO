const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '../../config/demo.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0 && !process.env[trimmed.slice(0, idx)]) {
      process.env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
}

loadEnv();

if (process.env.DEMO_TNS_ADMIN) {
  process.env.TNS_ADMIN = process.env.DEMO_TNS_ADMIN;
}

const services = require('../../config/services.json');
const workload = require('../../config/workload.json');
const packageJson = require('../../package.json');

function numberEnv(name, fallback) {
  return Number(process.env[name] || fallback);
}

function normalizeMode(value) {
  const normalized = String(value || 'traditional').trim().toLowerCase();
  if (['drcp', 'pooled'].includes(normalized)) return 'drcp';
  if (['traditional', 'dedicated'].includes(normalized)) return 'traditional';
  throw new Error(`Invalid benchmark mode "${value}". Use "traditional" or "drcp".`);
}

function drcpConnectString(base) {
  if (process.env.DEMO_DRCP_CONNECT_STRING) return process.env.DEMO_DRCP_CONNECT_STRING;
  if (!base) return base;
  if (base.includes(':pooled') || base.includes('SERVER=POOLED') || base.includes('server=pooled')) return base;
  return `${base}:pooled`;
}

const executionMode = normalizeMode(process.env.BENCHMARK_MODE || process.env.DRCP_EXECUTION_MODE || 'traditional');

module.exports = {
  port: Number(process.env.PORT || 8080),
  applicationVersion: packageJson.version || '0.0.0',
  benchmarkVersion: process.env.BENCHMARK_VERSION || '1.0.0',
  executionMode,
  dbDriver: process.env.DB_DRIVER || 'oracledb',
  oracleClientMode: process.env.ORACLE_CLIENT_MODE || 'thin',
  oracleClientLibDir: process.env.ORACLE_CLIENT_LIB_DIR || '',
  baseConnectString: process.env.DEMO_CONNECT_STRING || 'YOUR_ADB_TP_ALIAS',
  admin: {
    user: process.env.ADMIN_USER || 'ADMIN',
    password: process.env.ADMIN_PASSWORD || '',
    connectString: process.env.ADMIN_CONNECT_STRING || process.env.DEMO_CONNECT_STRING || 'YOUR_ADB_TP_ALIAS'
  },
  ordsMetricsBaseUrl: process.env.ORDS_METRICS_BASE_URL || '',
  servicePassword: process.env.DRCP_PASSWORD || '',
  samplingIntervalMs: numberEnv('BENCHMARK_SAMPLE_INTERVAL_MS', 2000),
  benchmark: {
    warmupSeconds: numberEnv('BENCHMARK_WARMUP_SECONDS', workload.default.warmupSeconds || 10),
    durationSeconds: numberEnv('BENCHMARK_DURATION_SECONDS', workload.default.durationSeconds || 45),
    concurrency: numberEnv('BENCHMARK_CONCURRENCY', workload.default.concurrency || 12),
    connectionBudget: numberEnv('APPLICATION_CONNECTION_BUDGET', workload.default.connectionBudget || 20),
    requestDelayMs: numberEnv('BENCHMARK_REQUEST_DELAY_MS', workload.default.requestDelayMs || 100),
    warmupDelayMs: numberEnv('BENCHMARK_WARMUP_DELAY_MS', workload.default.warmupDelayMs || 250),
    requestMix: workload.requestMix || {}
  },
  defaultPurity: process.env.DRCP_DEFAULT_PURITY || 'POOLED',
  defaultTagStrategy: process.env.DRCP_TAGGING_STRATEGY || 'mixed',
  pool: {
    increment: numberEnv('POOL_INCREMENT', 1),
    initializeOnStart: String(process.env.INITIALIZE_POOLS_ON_START || 'true').toLowerCase() === 'true',
    traditional: {
      min: numberEnv('TRADITIONAL_POOL_MIN', process.env.POOL_MIN || 5),
      max: numberEnv('TRADITIONAL_POOL_MAX', process.env.POOL_MAX || 8)
    },
    drcp: {
      min: numberEnv('DRCP_POOL_MIN', 0),
      max: numberEnv('DRCP_POOL_MAX', process.env.POOL_MAX || 8),
      residentMin: numberEnv('DRCP_RESIDENT_MIN', 2),
      residentMax: numberEnv('DRCP_RESIDENT_MAX', 8)
    }
  },
  databaseSessionLimit: numberEnv('DB_SESSION_LIMIT', 200),
  databaseCallTimeoutMs: numberEnv('DATABASE_CALL_TIMEOUT_MS', 10000),
  poolInitializeTimeoutMs: numberEnv('POOL_INITIALIZE_TIMEOUT_MS', 20000),
  services,
  drcpConnectString
};
