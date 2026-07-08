'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const demoRoot = path.join(root, '..');

function loadLocalEnv() {
  for (const file of ['config.local.env']) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) continue;
    for (const line of fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0 && process.env[trimmed.slice(0, idx)] === undefined) {
        process.env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
      }
    }
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function numberValue(args, key, envName, fallback) {
  return Number(args[key] ?? process.env[envName] ?? fallback);
}

function stringValue(args, key, envName, fallback) {
  return String(args[key] ?? process.env[envName] ?? fallback ?? '');
}

function loadDefaultServiceUsers() {
  const servicesPath = path.join(demoRoot, 'config', 'services.json');
  try {
    const services = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
    return Object.values(services).map(service => service.schema).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function listValue(args, key, envName, fallbackList) {
  const raw = args[key] ?? process.env[envName];
  if (!raw) return fallbackList;
  return String(raw)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function loadConfig(argv) {
  loadLocalEnv();
  const args = parseArgs(argv);
  const password = stringValue(args, 'password', 'POOL_TEST_PASSWORD', '');
  if (!password) {
    throw new Error('Missing password. Set POOL_TEST_PASSWORD or pass --password. Do not store secrets in source files.');
  }

  const tnsAdmin = stringValue(args, 'tnsAdmin', 'POOL_TEST_TNS_ADMIN', path.join(demoRoot, 'wallet'));
  if (tnsAdmin) process.env.TNS_ADMIN = tnsAdmin;

  const defaultServiceUsers = loadDefaultServiceUsers();
  const serviceUsers = listValue(args, 'serviceUsers', 'POOL_TEST_SERVICE_USERS', defaultServiceUsers);

  return {
    root,
    runId: stringValue(args, 'runId', 'POOL_TEST_RUN_ID', `pool-diagnostic-${Date.now()}`),
    experiment: stringValue(args, 'experiment', 'POOL_TEST_EXPERIMENT', 'all'),
    user: stringValue(args, 'user', 'POOL_TEST_USER', 'DRCP_CATALOG'),
    password,
    connectString: stringValue(args, 'connectString', 'POOL_TEST_CONNECT_STRING', 'YOUR_ADB_TP_ALIAS'),
    oracleClientMode: stringValue(args, 'oracleClientMode', 'POOL_TEST_ORACLE_CLIENT_MODE', 'thick'),
    oracleClientLibDir: stringValue(args, 'oracleClientLibDir', 'POOL_TEST_ORACLE_CLIENT_LIB_DIR', ''),
    tnsAdmin,
    ordsMetricsBaseUrl: stringValue(args, 'ordsMetricsBaseUrl', 'POOL_TEST_ORDS_METRICS_BASE_URL', ''),
    poolMin: numberValue(args, 'poolMin', 'POOL_TEST_POOL_MIN', 5),
    poolMax: numberValue(args, 'poolMax', 'POOL_TEST_POOL_MAX', 8),
    poolIncrement: numberValue(args, 'poolIncrement', 'POOL_TEST_POOL_INCREMENT', 1),
    poolTimeout: numberValue(args, 'poolTimeout', 'POOL_TEST_POOL_TIMEOUT', 60),
    poolCount: numberValue(args, 'pools', 'POOL_TEST_POOL_COUNT', 5),
    warmupWaitMs: numberValue(args, 'warmupWaitMs', 'POOL_TEST_WARMUP_WAIT_MS', 30000),
    sampleIntervalMs: numberValue(args, 'sampleIntervalMs', 'POOL_TEST_SAMPLE_INTERVAL_MS', 1000),
    demoWarmupRounds: numberValue(args, 'demoWarmupRounds', 'POOL_TEST_DEMO_WARMUP_ROUNDS', 3),
    demoWarmupConcurrency: numberValue(args, 'demoWarmupConcurrency', 'POOL_TEST_DEMO_WARMUP_CONCURRENCY', 2),
    stopOnFailure: String(args.stopOnFailure ?? process.env.POOL_TEST_STOP_ON_FAILURE ?? 'true').toLowerCase() !== 'false',
    serviceUsers,
    sizes: stringValue(args, 'sizes', 'POOL_TEST_SIZES', '1,2,3,4,5,8,10')
      .split(',')
      .map(value => Number(value.trim()))
      .filter(value => Number.isFinite(value) && value > 0)
  };
}

module.exports = { loadConfig };
