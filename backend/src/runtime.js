const config = require('./config');

function currentPoolConfig(mode = config.executionMode) {
  return mode === 'drcp' ? config.pool.drcp : config.pool.traditional;
}

function connectionStringForMode(mode = config.executionMode) {
  return mode === 'drcp'
    ? config.drcpConnectString(config.baseConnectString)
    : config.baseConnectString;
}

function datasourceImplementation(mode = config.executionMode) {
  return mode === 'drcp'
    ? 'node-oracledb client pool using Oracle Database Resident Connection Pooling'
    : 'node-oracledb client-side dedicated connection pool';
}

function poolImplementation(mode = config.executionMode) {
  return mode === 'drcp'
    ? 'Database-resident pooled servers with small client-side request pools'
    : 'Dedicated database sessions owned by each service client pool';
}

function getRuntimeConfiguration() {
  const mode = config.executionMode;
  const pool = currentPoolConfig(mode);
  return {
    executionMode: mode,
    datasourceImplementation: datasourceImplementation(mode),
    connectionUrl: connectionStringForMode(mode),
    poolImplementation: poolImplementation(mode),
    initialPoolSize: pool.min,
    maxPoolSize: pool.max,
    poolIncrement: config.pool.increment,
    connectionClass: mode === 'drcp' ? 'service-specific DRCP_DEMO_* classes' : null,
    purity: mode === 'drcp' ? config.defaultPurity : null,
    tagging: mode === 'drcp' ? config.defaultTagStrategy : null,
    drcpEnabled: mode === 'drcp',
    databaseServerMode: mode === 'drcp' ? 'SERVER=POOLED' : 'SERVER=DEDICATED',
    applicationVersion: config.applicationVersion,
    benchmarkVersion: config.benchmarkVersion,
    benchmarkDefaults: {
      warmupSeconds: config.benchmark.warmupSeconds,
      durationSeconds: config.benchmark.durationSeconds,
      concurrency: config.benchmark.concurrency,
      connectionBudget: config.benchmark.connectionBudget,
      requestDelayMs: config.benchmark.requestDelayMs,
      warmupDelayMs: config.benchmark.warmupDelayMs,
      requestMix: config.benchmark.requestMix
    },
    samplingIntervalMs: config.samplingIntervalMs,
    services: Object.entries(config.services).map(([name, svc]) => ({
      name,
      schema: svc.schema,
      connectionClass: mode === 'drcp' ? svc.connectionClass : null,
      defaultTag: mode === 'drcp' ? svc.defaultTag : null
    }))
  };
}

function describeMode(mode) {
  const pool = currentPoolConfig(mode);
  return {
    executionMode: mode,
    datasourceImplementation: datasourceImplementation(mode),
    connectionUrl: connectionStringForMode(mode),
    poolImplementation: poolImplementation(mode),
    initialPoolSize: pool.min,
    maxPoolSize: pool.max,
    databaseServerMode: mode === 'drcp' ? 'SERVER=POOLED' : 'SERVER=DEDICATED',
    connectionClass: mode === 'drcp' ? 'enabled per service' : 'not supported',
    purity: mode === 'drcp' ? config.defaultPurity : 'not supported',
    tagging: mode === 'drcp' ? config.defaultTagStrategy : 'not supported',
    drcpEnabled: mode === 'drcp'
  };
}

function getConfigurationComparison() {
  return {
    activeMode: config.executionMode,
    traditional: describeMode('traditional'),
    drcp: describeMode('drcp'),
    differences: [
      { setting: 'Database server mode', traditional: 'SERVER=DEDICATED', drcp: 'SERVER=POOLED' },
      { setting: 'Idle footprint', traditional: 'Pool minimum is multiplied by service count', drcp: 'Resident servers are shared across services' },
      { setting: 'Connection class', traditional: 'Not supported', drcp: 'Used to isolate reusable pooled server state' },
      { setting: 'Purity', traditional: 'Not supported', drcp: 'Controls pooled server reuse semantics' },
      { setting: 'Tagging', traditional: 'Not supported', drcp: 'Used for session state matching and fix-up' }
    ]
  };
}

module.exports = {
  currentPoolConfig,
  connectionStringForMode,
  getRuntimeConfiguration,
  getConfigurationComparison
};
