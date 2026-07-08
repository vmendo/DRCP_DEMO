'use strict';

const oracledb = require('oracledb');
const { collectEvidence } = require('./evidence');

let oracleClientInitialized = false;

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function poolOpen(pool) {
  return Number(pool.connectionsOpen ?? pool.connectionsOpenCount ?? 0);
}

function poolInUse(pool) {
  return Number(pool.connectionsInUse ?? pool.connectionsInUseCount ?? 0);
}

function timeoutPromise(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

function initializeOracleClient(config) {
  if (oracleClientInitialized || config.oracleClientMode !== 'thick') return;
  const options = {};
  if (config.oracleClientLibDir) options.libDir = config.oracleClientLibDir;
  oracledb.initOracleClient(options);
  oracleClientInitialized = true;
}

function userForPool(config, index) {
  return (config.serviceUsers && config.serviceUsers[index]) || config.user;
}

async function createPool(config, label, poolMin, poolMax, user = config.user) {
  const startMs = Date.now();
  const pool = await oracledb.createPool({
    user,
    password: config.password,
    connectString: config.connectString,
    poolMin: 0,
    poolMax,
    poolIncrement: config.poolIncrement,
    poolTimeout: config.poolTimeout,
    queueTimeout: Math.max(10000, config.poolTimeout * 1000)
  });
  return {
    label,
    pool,
    createdAt: now(),
    createMs: Date.now() - startMs,
    targetMin: poolMin,
    targetMax: poolMax,
    user,
    samples: [],
    errors: [],
    timeToFirstConnectionMs: null,
    timeToFullWarmupMs: null
  };
}

async function closePool(poolRecord) {
  if (!poolRecord || !poolRecord.pool) return;
  try {
    await poolRecord.pool.close(5);
  } catch (err) {
    poolRecord.errors.push({ at: now(), phase: 'close', message: err.message, code: err.code });
  }
}

async function checkedConnection(poolRecord) {
  const connection = await poolRecord.pool.getConnection();
  try {
    await connection.execute('select 1 from dual');
  } finally {
    await connection.close();
  }
}

async function acquireWithTimeout(poolRecord, timeoutMs) {
  const connection = await Promise.race([
    poolRecord.pool.getConnection(),
    timeoutPromise(timeoutMs, `${poolRecord.label} connection checkout timed out after ${timeoutMs} ms`)
  ]);
  connection.callTimeout = Math.max(10000, timeoutMs);
  return connection;
}

async function closeConnection(connection, drop = false) {
  if (!connection) return;
  try {
    if (drop) {
      await connection.close({ drop: true });
      return;
    }
  } catch (_) {
    // Older node-oracledb clients may not support close({ drop: true }).
  }
  await connection.close().catch(() => {});
}

async function validateConnection(connection) {
  await connection.execute('select 1 as ok from dual');
}

async function warmPool(config, poolRecord) {
  const startMs = Date.now();
  const deadline = Date.now() + config.warmupWaitMs;
  while (Date.now() < deadline && poolOpen(poolRecord.pool) < poolRecord.targetMin) {
    const before = Date.now();
    try {
      await Promise.race([
        checkedConnection(poolRecord),
        timeoutPromise(Math.max(10000, config.poolTimeout * 1000), `${poolRecord.label} connection checkout timed out`)
      ]);
      const open = poolOpen(poolRecord.pool);
      if (open > 0 && poolRecord.timeToFirstConnectionMs === null) {
        poolRecord.timeToFirstConnectionMs = Date.now() - startMs;
      }
      if (open >= poolRecord.targetMin && poolRecord.timeToFullWarmupMs === null) {
        poolRecord.timeToFullWarmupMs = Date.now() - startMs;
      }
    } catch (err) {
      poolRecord.errors.push({ at: now(), phase: 'warmup', message: err.message, code: err.code });
    }
    poolRecord.samples.push({
      at: now(),
      elapsedMs: Date.now() - startMs,
      requestMs: Date.now() - before,
      connectionsOpen: poolOpen(poolRecord.pool),
      connectionsInUse: poolInUse(poolRecord.pool)
    });
    if (poolOpen(poolRecord.pool) >= poolRecord.targetMin) break;
    await sleep(config.sampleIntervalMs);
  }
  return summarizePool(poolRecord);
}

async function materializeLikeDemo(config, poolRecord) {
  if (poolRecord.targetMin <= 0) return summarizePool(poolRecord);
  const startMs = Date.now();
  const deadline = Date.now() + config.warmupWaitMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const connections = [];
    let validConnections = 0;
    try {
      for (let i = 0; i < poolRecord.targetMin; i += 1) {
        const remaining = Math.max(1000, deadline - Date.now());
        const connection = await acquireWithTimeout(poolRecord, Math.min(10000, remaining));
        try {
          await validateConnection(connection);
          validConnections += 1;
          connections.push({ connection, drop: false });
        } catch (err) {
          lastError = err;
          connections.push({ connection, drop: true });
        }

        const open = poolOpen(poolRecord.pool);
        if (open > 0 && poolRecord.timeToFirstConnectionMs === null) poolRecord.timeToFirstConnectionMs = Date.now() - startMs;
        if (open >= poolRecord.targetMin && poolRecord.timeToFullWarmupMs === null) poolRecord.timeToFullWarmupMs = Date.now() - startMs;
        poolRecord.samples.push({
          at: now(),
          elapsedMs: Date.now() - startMs,
          requestMs: null,
          connectionsOpen: open,
          connectionsInUse: poolInUse(poolRecord.pool)
        });
      }
    } catch (err) {
      lastError = err;
      poolRecord.errors.push({ at: now(), phase: 'demo-materialize', message: err.message, code: err.code });
    } finally {
      await Promise.all(connections.map(({ connection, drop }) => closeConnection(connection, drop)));
    }

    if (validConnections >= poolRecord.targetMin && poolOpen(poolRecord.pool) >= poolRecord.targetMin) break;
    await sleep(config.sampleIntervalMs);
  }

  if (poolOpen(poolRecord.pool) < poolRecord.targetMin) {
    poolRecord.errors.push({
      at: now(),
      phase: 'demo-materialize',
      message: `${poolRecord.label} opened ${poolOpen(poolRecord.pool)}/${poolRecord.targetMin}${lastError ? `; last error: ${lastError.message}` : ''}`,
      code: lastError && lastError.code
    });
  }

  if (poolOpen(poolRecord.pool) >= poolRecord.targetMin && typeof poolRecord.pool.reconfigure === 'function') {
    try {
      await poolRecord.pool.reconfigure({
        poolMin: poolRecord.targetMin,
        poolMax: poolRecord.targetMax,
        poolIncrement: config.poolIncrement
      });
    } catch (err) {
      poolRecord.errors.push({ at: now(), phase: 'reconfigure', message: err.message, code: err.code });
    }
  }
  return summarizePool(poolRecord);
}

async function runDemoWarmupWorkload(config, poolRecords) {
  const errors = [];
  for (let round = 0; round < config.demoWarmupRounds; round += 1) {
    for (let start = 0; start < poolRecords.length; start += config.demoWarmupConcurrency) {
      const batch = poolRecords.slice(start, start + config.demoWarmupConcurrency);
      await Promise.all(batch.map(async poolRecord => {
        let connection;
        try {
          connection = await acquireWithTimeout(poolRecord, Math.max(10000, config.poolTimeout * 1000));
          await validateConnection(connection);
        } catch (err) {
          const item = { at: now(), phase: 'demo-workload', message: err.message, code: err.code };
          errors.push({ poolId: poolRecord.label, ...item });
          poolRecord.errors.push(item);
        } finally {
          await closeConnection(connection);
        }
      }));
    }
  }
  return errors;
}

async function sampleHold(config, poolRecord, targetConnections) {
  const holders = [];
  const startMs = Date.now();
  for (let i = 0; i < targetConnections; i += 1) {
    try {
      const connection = await poolRecord.pool.getConnection();
      await connection.execute('select 1 from dual');
      holders.push(connection);
      const open = poolOpen(poolRecord.pool);
      if (open > 0 && poolRecord.timeToFirstConnectionMs === null) poolRecord.timeToFirstConnectionMs = Date.now() - startMs;
      if (open >= targetConnections && poolRecord.timeToFullWarmupMs === null) poolRecord.timeToFullWarmupMs = Date.now() - startMs;
      poolRecord.samples.push({
        at: now(),
        elapsedMs: Date.now() - startMs,
        requestMs: null,
        connectionsOpen: open,
        connectionsInUse: poolInUse(poolRecord.pool)
      });
    } catch (err) {
      poolRecord.errors.push({ at: now(), phase: 'hold', message: err.message, code: err.code });
    }
  }
  await sleep(Math.min(2000, config.sampleIntervalMs));
  for (const connection of holders) {
    try {
      await connection.close();
    } catch (_) {
      // Closing failures are captured by pool.close if they matter.
    }
  }
  poolRecord.samples.push({
    at: now(),
    elapsedMs: Date.now() - startMs,
    requestMs: null,
    connectionsOpen: poolOpen(poolRecord.pool),
    connectionsInUse: poolInUse(poolRecord.pool)
  });
  return summarizePool(poolRecord);
}

function summarizePool(poolRecord) {
  return {
    poolId: poolRecord.label,
    user: poolRecord.user,
    requestedPoolMin: poolRecord.targetMin,
    requestedPoolMax: poolRecord.targetMax,
    createMs: poolRecord.createMs,
    actualConnectionsOpen: poolOpen(poolRecord.pool),
    actualConnectionsInUse: poolInUse(poolRecord.pool),
    timeToFirstConnectionMs: poolRecord.timeToFirstConnectionMs,
    timeToFullWarmupMs: poolRecord.timeToFullWarmupMs,
    fullWarmup: poolOpen(poolRecord.pool) >= poolRecord.targetMin,
    errorCount: poolRecord.errors.length,
    errors: poolRecord.errors,
    samples: poolRecord.samples
  };
}

function summarizeExperiment(name, pools) {
  const requestedConnections = pools.reduce((sum, pool) => sum + pool.requestedPoolMin, 0);
  const openConnections = pools.reduce((sum, pool) => sum + pool.actualConnectionsOpen, 0);
  const fullWarmup = openConnections >= requestedConnections && pools.every(pool => pool.fullWarmup);
  const errorCount = pools.reduce((sum, pool) => sum + pool.errorCount, 0);
  const status = errorCount > 0 ? 'degraded' : (fullWarmup ? 'stable' : 'failed');
  return {
    requestedConnections,
    openConnections,
    fullWarmup,
    status,
    errorCount,
    maxTimeToFullWarmupMs: Math.max(0, ...pools.map(pool => pool.timeToFullWarmupMs || 0)),
    conclusion: fullWarmup && errorCount === 0
      ? `${name} reached the requested connection target.`
      : `${name} opened ${openConnections}/${requestedConnections}; inspect errors, wait times, and Oracle evidence.`
  };
}

async function runSingle(config, name, targetMin, targetMax) {
  const evidenceBefore = await collectEvidence(config);
  const record = await createPool(config, `${name}-pool-1`, targetMin, targetMax);
  let poolSummary;
  try {
    poolSummary = await sampleHold(config, record, targetMin);
  } finally {
    await closePool(record);
  }
  const evidenceAfter = await collectEvidence(config);
  return {
    name,
    startedAt: record.createdAt,
    finishedAt: now(),
    mode: 'single',
    pools: [poolSummary],
    evidenceBefore,
    evidenceAfter,
    summary: summarizeExperiment(name, [poolSummary])
  };
}

async function runFive(config, name, parallel, targetMin = config.poolMin, targetMax = config.poolMax) {
  const evidenceBefore = await collectEvidence(config);
  const records = [];
  const make = async index => {
    const record = await createPool(config, `${name}-pool-${index + 1}`, targetMin, targetMax, userForPool(config, index));
    records[index] = record;
    return sampleHold(config, record, targetMin);
  };
  let poolSummaries;
  try {
    poolSummaries = parallel
      ? await Promise.all(Array.from({ length: config.poolCount }, (_, index) => make(index)))
      : [];
    if (!parallel) {
      for (let i = 0; i < config.poolCount; i += 1) {
        poolSummaries.push(await make(i));
      }
    }
  } finally {
    for (const record of records) await closePool(record);
  }
  const evidenceAfter = await collectEvidence(config);
  return {
    name,
    startedAt: now(),
    finishedAt: now(),
    mode: parallel ? 'parallel' : 'serial',
    pools: poolSummaries,
    evidenceBefore,
    evidenceAfter,
    summary: summarizeExperiment(name, poolSummaries)
  };
}

async function runFiveDemoLike(config, name, parallel, targetMin, targetMax) {
  const evidenceBefore = await collectEvidence(config);
  const records = [];
  const make = async index => {
    const record = await createPool(config, `${name}-pool-${index + 1}`, targetMin, targetMax, userForPool(config, index));
    records[index] = record;
    return materializeLikeDemo(config, record);
  };
  let poolSummaries;
  let workloadErrors = [];
  try {
    poolSummaries = parallel
      ? await Promise.all(Array.from({ length: config.poolCount }, (_, index) => make(index)))
      : [];
    if (!parallel) {
      for (let i = 0; i < config.poolCount; i += 1) {
        poolSummaries.push(await make(i));
      }
    }
    workloadErrors = await runDemoWarmupWorkload(config, records);
    poolSummaries = records.map(record => summarizePool(record));
  } finally {
    for (const record of records) await closePool(record);
  }
  const evidenceAfter = await collectEvidence(config);
  const experiment = {
    name,
    startedAt: now(),
    finishedAt: now(),
    mode: parallel ? 'demo-like-parallel' : 'demo-like-serial',
    pools: poolSummaries,
    workloadErrors,
    evidenceBefore,
    evidenceAfter,
    summary: summarizeExperiment(name, poolSummaries)
  };
  if (workloadErrors.length && experiment.summary.status === 'stable') {
    experiment.summary.status = 'degraded';
    experiment.summary.errorCount += workloadErrors.length;
    experiment.summary.conclusion = `${name} warmed up but demo-like workload reported ${workloadErrors.length} error(s).`;
  }
  return experiment;
}

async function runSingleGrowth(config) {
  const experiments = [];
  for (const size of config.sizes.filter(size => size <= config.poolMax)) {
    experiments.push(await runSingle(config, `single-growth-${size}`, size, Math.max(size, config.poolMax)));
  }
  return experiments;
}

async function runCompareSingleMultiple(config) {
  const total = config.poolMin * config.poolCount;
  const single = await runSingle(config, `single-large-${total}`, total, Math.max(total, config.poolMax * config.poolCount));
  const multiple = await runFive(config, `multiple-small-${config.poolCount}x${config.poolMin}`, false, config.poolMin, config.poolMax);
  return [single, multiple];
}

async function runSweep(config) {
  const experiments = [];
  for (const size of config.sizes) {
    experiments.push(await runFive(config, `serial-sweep-${config.poolCount}x${size}`, false, size, Math.max(size, config.poolMax)));
  }
  return experiments;
}

function targetMaxForThreshold(config, size) {
  return Math.min(config.poolMax, Math.max(size * 2, size + 1));
}

function isUnstable(experiment) {
  return !experiment.summary.fullWarmup || experiment.summary.errorCount > 0 || experiment.summary.status !== 'stable';
}

async function runThresholdSweep(config) {
  const experiments = [];
  for (const size of config.sizes.filter(value => value >= 1 && value <= 5)) {
    const targetMax = targetMaxForThreshold(config, size);
    const serial = await runFive(config, `threshold-serial-5x${size}`, false, size, targetMax);
    experiments.push(serial);
    if (config.stopOnFailure && isUnstable(serial)) break;

    const parallel = await runFive(config, `threshold-parallel-5x${size}`, true, size, targetMax);
    experiments.push(parallel);
    if (config.stopOnFailure && isUnstable(parallel)) break;

    const demoLike = await runFiveDemoLike(config, `threshold-demo-like-5x${size}`, false, size, targetMax);
    experiments.push(demoLike);
    if (config.stopOnFailure && isUnstable(demoLike)) break;
  }
  return experiments;
}

async function runExperiment(config) {
  initializeOracleClient(config);
  const result = {
    runId: config.runId,
    startedAt: now(),
    configuration: {
      experiment: config.experiment,
      user: config.user,
      connectString: config.connectString,
      oracleClientMode: config.oracleClientMode,
      tnsAdmin: config.tnsAdmin,
      poolMin: config.poolMin,
      poolMax: config.poolMax,
      poolIncrement: config.poolIncrement,
      poolTimeout: config.poolTimeout,
      poolCount: config.poolCount,
      warmupWaitMs: config.warmupWaitMs,
      sampleIntervalMs: config.sampleIntervalMs,
      demoWarmupRounds: config.demoWarmupRounds,
      demoWarmupConcurrency: config.demoWarmupConcurrency,
      stopOnFailure: config.stopOnFailure,
      serviceUsers: config.serviceUsers,
      sizes: config.sizes
    },
    experiments: []
  };

  if (config.experiment === 'single-growth' || config.experiment === 'all') {
    result.experiments.push(...await runSingleGrowth(config));
  }
  if (config.experiment === 'serial-five' || config.experiment === 'all') {
    result.experiments.push(await runFive(config, 'five-pools-serial', false));
  }
  if (config.experiment === 'parallel-five' || config.experiment === 'all') {
    result.experiments.push(await runFive(config, 'five-pools-parallel', true));
  }
  if (config.experiment === 'compare-single-multiple' || config.experiment === 'all') {
    result.experiments.push(...await runCompareSingleMultiple(config));
  }
  if (config.experiment === 'sweep' || config.experiment === 'all') {
    result.experiments.push(...await runSweep(config));
  }
  if (config.experiment === 'threshold-sweep') {
    result.experiments.push(...await runThresholdSweep(config));
  }
  if (result.experiments.length === 0) {
    throw new Error(`Unknown experiment "${config.experiment}". Use single-growth, serial-five, parallel-five, compare-single-multiple, sweep, threshold-sweep, or all.`);
  }
  result.finishedAt = now();
  return result;
}

module.exports = { runExperiment };
