const config = require('../config');
const { runService } = require('../services');
const { getPoolMetrics } = require('../db/monitoring');
const { createRun, insertSample, updateRunState, finishRun } = require('../db/benchmarkRepository');
const { getRuntimeConfiguration } = require('../runtime');

let activeRun = null;
const STATES = {
  READY: 'READY',
  INITIALIZING: 'INITIALIZING',
  RUNNING: 'RUNNING',
  DRAINING: 'DRAINING',
  SAVING_RESULTS: 'SAVING_RESULTS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
};

function pickService(i) {
  const names = weightedServiceSequence();
  return names[i % names.length];
}

function weightedServiceSequence() {
  const mix = config.benchmark.requestMix || {};
  const weighted = Object.keys(config.services).map(serviceName => ({
    serviceName,
    weight: Math.max(1, Math.max(0, Number(mix[serviceName] || 0)))
  }));
  const maxWeight = Math.max(...weighted.map(row => row.weight), 1);
  const sequence = [];
  for (let slot = 0; slot < maxWeight; slot += 1) {
    for (const row of weighted) {
      if (slot < row.weight) sequence.push(row.serviceName);
    }
  }
  return sequence.length ? sequence : Object.keys(config.services);
}

function tagFor(service, strategy, i) {
  if (!strategy) return null;
  const base = config.services[service].defaultTag;
  if (strategy === 'fixed') return base;
  const region = i % 2 === 0 ? 'US-W' : 'US-C';
  const role = i % 3 === 0 ? 'READ_WRITE' : 'READ_ONLY';
  return `SERVICE=${service.toUpperCase()};REGION=${region};ROLE=${role}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startLoad(options) {
  if (activeRun && ['INITIALIZING', 'RUNNING', 'DRAINING', 'SAVING_RESULTS'].includes(activeRun.state)) {
    throw new Error('A benchmark run is already active');
  }
  const runtime = getRuntimeConfiguration();
  const run = {
    id: `run-${Date.now()}`,
    state: STATES.INITIALIZING,
    running: true,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    stopRequestedAt: null,
    drainCompletedAt: null,
    saveCompletedAt: null,
    completedAt: null,
    phase: 'INITIALIZING',
    executionMode: config.executionMode,
    options: {
      ...options,
      concurrency: Number(options.concurrency || config.benchmark.concurrency),
      durationSeconds: Number(options.durationSeconds || config.benchmark.durationSeconds),
      warmupSeconds: Number(options.warmupSeconds ?? config.benchmark.warmupSeconds),
      requestDelayMs: Number(options.requestDelayMs ?? config.benchmark.requestDelayMs),
      warmupDelayMs: Number(options.warmupDelayMs ?? config.benchmark.warmupDelayMs),
      mode: config.executionMode
    },
    runtime,
    completedRequests: 0,
    errors: 0,
    warmupRequests: 0,
    warmupErrors: 0,
    measurementStartedAt: null,
    measurementEndedAt: null,
    inFlightRequests: 0,
    activeRequests: 0,
    latencies: [],
    samples: [],
    finalMetrics: null,
    peaks: {
      latencyMs: 0,
      throughputRps: 0,
      reservedSessions: 0,
      activeSessions: 0,
      idleSessions: 0,
      residentServers: 0
    }
  };
  activeRun = run;
  await createRun({
    id: run.id,
    executionMode: config.executionMode,
    configuration: runtime,
    connectionStrategy: runtime.poolImplementation,
    connectionClass: runtime.connectionClass,
    purity: runtime.purity,
    tagging: runtime.tagging,
    status: STATES.INITIALIZING
  });
  const durationMs = run.options.durationSeconds * 1000;
  const concurrency = run.options.concurrency;
  const warmupMs = Math.max(0, Number(options.warmupSeconds ?? config.benchmark.warmupSeconds) * 1000);
  const warmupConcurrency = Math.max(1, Math.min(2, concurrency));
  let generationEndsAt = 0;
  let lastSampleAt = Date.now();
  let lastSampleRequests = 0;
  let generationOpen = true;
  let drainRequested = false;
  let durationTimer = null;

  function setState(nextState) {
    run.state = nextState;
    run.running = ['INITIALIZING', 'RUNNING', 'DRAINING', 'SAVING_RESULTS'].includes(nextState);
    return updateRunState(run.id, nextState).catch(() => {});
  }

  function latencySummary() {
    if (!run.latencies.length) return { average: 0, p95: 0, peak: 0 };
    const sorted = [...run.latencies].sort((a, b) => a - b);
    const sum = run.latencies.reduce((total, value) => total + value, 0);
    return {
      average: Math.round((sum / run.latencies.length) * 100) / 100,
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      peak: sorted[sorted.length - 1]
    };
  }

  function summarizeOracleMetrics(metrics) {
    const totals = metrics.totals || {};
    const reserved = config.executionMode === 'drcp'
      ? Number(totals.drcp_open_servers || totals.pooled_sessions || 0)
      : Number(totals.dedicated_sessions || 0);
    const active = Number(config.executionMode === 'drcp'
      ? totals.pooled_active_sessions || totals.active_sessions || 0
      : totals.dedicated_active_sessions || totals.active_sessions || 0);
    const idle = Math.max(0, reserved - active);
    const requests = Number((metrics.cpoolTotals || {}).requests || 0);
    const hits = Number((metrics.cpoolTotals || {}).hits || 0);
    return {
      reservedSessions: reserved,
      activeSessions: active,
      idleSessions: idle,
      residentServers: Number(totals.drcp_open_servers || 0),
      connectionReuseRatio: requests > 0 ? Math.round((hits / requests) * 10000) / 100 : null
    };
  }

  async function sample({ final = false, requireAvailable = false } = {}) {
    const now = Date.now();
    const elapsedSeconds = Math.max(0.001, (now - lastSampleAt) / 1000);
    const requestsPerSec = Math.round(((run.completedRequests - lastSampleRequests) / elapsedSeconds) * 100) / 100;
    lastSampleAt = now;
    lastSampleRequests = run.completedRequests;
    const metricsTimeoutMs = final || requireAvailable
      ? Math.max(20000, config.databaseCallTimeoutMs + 10000)
      : Math.max(15000, config.databaseCallTimeoutMs + 5000);
    const metrics = await Promise.race([
      getPoolMetrics({ force: true }),
      new Promise(resolve => setTimeout(() => resolve({
        available: false,
        error: 'Pool metrics sample timed out'
      }), metricsTimeoutMs))
    ]);
    if (requireAvailable && metrics.available === false) {
      throw new Error(`Required benchmark sample unavailable: ${metrics.error || 'pool metrics unavailable'}`);
    }
    const latency = latencySummary();
    const oracle = summarizeOracleMetrics(metrics);
    run.peaks.latencyMs = Math.max(run.peaks.latencyMs, latency.peak);
    run.peaks.throughputRps = Math.max(run.peaks.throughputRps, requestsPerSec);
    run.peaks.reservedSessions = Math.max(run.peaks.reservedSessions, oracle.reservedSessions);
    run.peaks.activeSessions = Math.max(run.peaks.activeSessions, oracle.activeSessions);
    run.peaks.idleSessions = Math.max(run.peaks.idleSessions, oracle.idleSessions);
    run.peaks.residentServers = Math.max(run.peaks.residentServers, oracle.residentServers);
    const sampleRow = {
      lifecycleState: run.state,
      activeRequests: run.activeRequests,
      inFlightRequests: run.inFlightRequests,
      errors: run.errors,
      warmupRequests: run.warmupRequests,
      warmupErrors: run.warmupErrors,
      requestsPerSec,
      latencyMs: latency.average,
      currentDatabaseFootprint: oracle.reservedSessions,
      ...oracle,
      oracleMetrics: metrics
    };
    run.samples.push({ at: new Date().toISOString(), ...sampleRow });
    await insertSample(run.id, sampleRow);
    if (final) run.finalMetrics = sampleRow;
    return sampleRow;
  }

  async function executeRequest(i, measured) {
    const service = pickService(i);
    const isDrcp = config.executionMode === 'drcp';
    try {
      const started = Date.now();
      run.inFlightRequests += 1;
      run.activeRequests = run.inFlightRequests;
      await runService(service, {
        purity: isDrcp ? options.purity || config.defaultPurity : null,
        tag: isDrcp ? tagFor(service, options.tagStrategy || config.defaultTagStrategy, i) : null
      });
      if (measured) {
        run.latencies.push(Date.now() - started);
        run.completedRequests += 1;
      } else {
        run.warmupRequests += 1;
      }
    } catch (err) {
      if (measured) run.errors += 1;
      else run.warmupErrors += 1;
    } finally {
      run.inFlightRequests = Math.max(0, run.inFlightRequests - 1);
      run.activeRequests = run.inFlightRequests;
    }
  }

  async function runWarmup() {
    if (warmupMs <= 0) return;
    run.phase = 'WARM_UP';
    const warmupEndsAt = Date.now() + warmupMs;
    await Promise.all(Array.from({ length: warmupConcurrency }, async (_, workerId) => {
      let i = workerId;
      while (!run.stopRequested && Date.now() < warmupEndsAt) {
        await executeRequest(i, false);
        await sleep(run.options.warmupDelayMs);
        i += warmupConcurrency;
      }
    }));
    await sample().catch(() => {});
  }

  async function requestDrain() {
    if (drainRequested) return;
    drainRequested = true;
    generationOpen = false;
    run.phase = 'DRAIN';
    run.stopRequestedAt = run.stopRequestedAt || new Date().toISOString();
    run.measurementEndedAt = run.measurementEndedAt || new Date().toISOString();
    if (['INITIALIZING', 'RUNNING'].includes(run.state)) {
      await setState(STATES.DRAINING);
      await sample().catch(() => {});
    }
  }

  run.requestDrain = requestDrain;

  async function worker(workerId) {
    let i = workerId;
    while (generationOpen && !run.stopRequested && Date.now() < generationEndsAt) {
      await executeRequest(i, true);
      await sleep(run.options.requestDelayMs);
      i += concurrency;
    }
  }

  await sample().catch(() => {});
  await runWarmup();
  run.completedRequests = 0;
  run.errors = 0;
  run.latencies = [];
  lastSampleAt = Date.now();
  lastSampleRequests = 0;
  run.phase = 'MEASUREMENT';
  run.measurementStartedAt = new Date().toISOString();
  await setState(STATES.RUNNING);
  generationEndsAt = Date.now() + durationMs;

  const sampleTimer = setInterval(() => {
    if (['RUNNING', 'DRAINING'].includes(run.state)) sample().catch(() => {});
  }, config.samplingIntervalMs);

  durationTimer = setTimeout(() => {
    requestDrain().catch(() => {});
  }, durationMs);

  async function waitForDrain() {
    await requestDrain();
    while (run.inFlightRequests > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await sample().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(250, config.samplingIntervalMs / 2))));
    let finalSample = null;
    let finalError = null;
    const finalSampleDeadline = Date.now() + Math.max(60000, config.samplingIntervalMs * 4);
    while (!finalSample && Date.now() < finalSampleDeadline) {
      try {
        finalSample = await sample({ final: true, requireAvailable: true });
      } catch (err) {
        finalError = err;
        await new Promise(resolve => setTimeout(resolve, Math.min(2000, config.samplingIntervalMs)));
      }
    }
    if (!finalSample) {
      throw new Error(`Could not capture a valid final benchmark sample${finalError ? `: ${finalError.message}` : ''}`);
    }
    run.drainCompletedAt = new Date().toISOString();
    return finalSample;
  }

  Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)))
    .then(async () => {
      clearTimeout(durationTimer);
      clearInterval(sampleTimer);
      const finalSample = await waitForDrain();
      await setState(STATES.SAVING_RESULTS);
      run.completedAt = new Date().toISOString();
      const latency = latencySummary();
      const measurementDurationMs = Date.parse(run.measurementEndedAt || run.completedAt) - Date.parse(run.measurementStartedAt || run.startedAt);
      const durationSeconds = Math.max(0.001, measurementDurationMs / 1000);
      const persistedSamples = run.samples.length;
      const status = run.stopRequested ? 'STOPPED' : STATES.COMPLETED;
      const summaryText = `${runtime.executionMode.toUpperCase()} benchmark completed after draining ${run.completedRequests + run.errors} requests. Peak footprint ${run.peaks.reservedSessions}; final footprint ${finalSample.reservedSessions}.`;
      delete run.latencies;
      await finishRun(run.id, {
        status,
        durationMs: measurementDurationMs,
        totalRequests: run.completedRequests + run.errors,
        completedRequests: run.completedRequests,
        errors: run.errors,
        averageLatencyMs: latency.average,
        p95LatencyMs: latency.p95,
        peakLatencyMs: Math.max(run.peaks.latencyMs, latency.peak),
        peakThroughputRps: run.peaks.throughputRps || Math.round((run.completedRequests / durationSeconds) * 100) / 100,
        peakReservedSessions: run.peaks.reservedSessions,
        peakActiveSessions: run.peaks.activeSessions,
        peakIdleSessions: run.peaks.idleSessions,
        peakResidentServers: run.peaks.residentServers,
        finalReservedSessions: finalSample.reservedSessions,
        finalActiveSessions: finalSample.activeSessions,
        finalIdleSessions: finalSample.idleSessions,
        finalResidentServers: finalSample.residentServers,
        finalConnectionReuseRatio: finalSample.connectionReuseRatio,
        connectionReuseRatio: finalSample.connectionReuseRatio,
        oracleMetrics: finalSample.oracleMetrics,
        summaryText
      });
      run.persistedSamples = persistedSamples;
      run.saveCompletedAt = new Date().toISOString();
      run.state = status;
      run.running = false;
      delete run.requestDrain;
      run.summaryText = summaryText;
    })
    .catch(async err => {
      clearTimeout(durationTimer);
      clearInterval(sampleTimer);
      run.state = STATES.FAILED;
      run.running = false;
      delete run.requestDrain;
      run.completedAt = new Date().toISOString();
      await finishRun(run.id, {
        status: STATES.FAILED,
        durationMs: Date.parse(run.measurementEndedAt || run.completedAt) - Date.parse(run.measurementStartedAt || run.startedAt),
        totalRequests: run.completedRequests + run.errors,
        completedRequests: run.completedRequests,
        errors: run.errors + 1,
        averageLatencyMs: 0,
        p95LatencyMs: 0,
        peakLatencyMs: run.peaks.latencyMs,
        peakThroughputRps: run.peaks.throughputRps,
        peakReservedSessions: run.peaks.reservedSessions,
        peakActiveSessions: run.peaks.activeSessions,
        peakIdleSessions: run.peaks.idleSessions,
        peakResidentServers: run.peaks.residentServers,
        finalReservedSessions: run.finalMetrics ? run.finalMetrics.reservedSessions : null,
        finalActiveSessions: run.finalMetrics ? run.finalMetrics.activeSessions : null,
        finalIdleSessions: run.finalMetrics ? run.finalMetrics.idleSessions : null,
        finalResidentServers: run.finalMetrics ? run.finalMetrics.residentServers : null,
        finalConnectionReuseRatio: run.finalMetrics ? run.finalMetrics.connectionReuseRatio : null,
        connectionReuseRatio: run.finalMetrics ? run.finalMetrics.connectionReuseRatio : null,
        oracleMetrics: run.finalMetrics ? run.finalMetrics.oracleMetrics : null,
        summaryText: `Benchmark failed during ${run.state}: ${err.message}`,
        notes: err.message
      }).catch(() => {});
    });
  return getLoadState();
}

function stopLoad() {
  if (activeRun && ['INITIALIZING', 'RUNNING'].includes(activeRun.state)) {
    activeRun.stopRequested = true;
    activeRun.stopRequestedAt = new Date().toISOString();
    if (typeof activeRun.requestDrain === 'function') {
      activeRun.requestDrain().catch(() => {});
    }
  }
  return activeRun;
}

function getLoadState() {
  function publicSample(sample) {
    if (!sample) return null;
    const { oracleMetrics, ...summary } = sample;
    return summary;
  }

  if (!activeRun) {
    return {
      running: false,
      state: STATES.READY,
      benchmarkState: STATES.READY,
      currentRunId: null,
      elapsedMs: 0,
      draining: false,
      resultsSaved: false,
      inFlightRequests: 0,
      activeRequests: 0,
      completedRequests: 0,
      errors: 0,
      peaks: null,
      finalMetrics: null
    };
  }
  const { latencies, requestDrain, samples, ...publicRun } = activeRun;
  return {
    ...publicRun,
    samples: Array.isArray(samples) ? samples.slice(-20).map(publicSample) : [],
    finalMetrics: publicSample(activeRun.finalMetrics),
    benchmarkState: activeRun.state,
    currentRunId: activeRun.id,
    elapsedMs: Date.now() - Date.parse(activeRun.startedAt),
    draining: activeRun.state === STATES.DRAINING || activeRun.inFlightRequests > 0,
    resultsSaved: Boolean(activeRun.saveCompletedAt) && ['COMPLETED', 'FAILED', 'STOPPED'].includes(activeRun.state),
    peakBenchmarkFootprint: activeRun.peaks ? activeRun.peaks.reservedSessions : null,
    finalBenchmarkFootprint: activeRun.finalMetrics ? activeRun.finalMetrics.reservedSessions : null
  };
}

module.exports = { startLoad, stopLoad, getLoadState };
