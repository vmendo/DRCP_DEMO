const oracledb = require('oracledb');
const config = require('./config');
const { getRuntimeConfiguration } = require('./runtime');
const { getPoolMetrics } = require('./db/monitoring');
const { validateRepository, withAdminConnection } = require('./db/benchmarkRepository');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

async function databaseConnectivity() {
  return withAdminConnection(async connection => {
    const version = await connection.execute(`select banner_full as version from v$version where rownum = 1`);
    const users = await connection.execute(`
      select username
        from all_users
       where username in (${Object.values(config.services).map((_, i) => `:u${i}`).join(',')})
       order by username`, Object.fromEntries(Object.values(config.services).map((svc, i) => [`u${i}`, svc.schema])));
    return {
      ok: true,
      oracleVersion: version.rows[0] ? version.rows[0].VERSION : null,
      schemas: (users.rows || []).map(row => row.USERNAME)
    };
  });
}

async function validateBackend() {
  const runtime = getRuntimeConfiguration();
  const withTimeout = (promise, fallback, ms = 5000) => Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);
  const [database, repository, metrics] = await Promise.all([
    databaseConnectivity().catch(err => ({ ok: false, error: err.message })),
    validateRepository().catch(err => ({ available: false, error: err.message })),
    withTimeout(
      getPoolMetrics().catch(err => ({ available: false, error: err.message })),
      { available: false, error: 'Pool metrics validation timed out' }
    )
  ]);

  return {
    checkedAt: new Date().toISOString(),
    runtime,
    databaseConnectivity: database,
    drcpStatus: {
      enabledForRuntime: runtime.drcpEnabled,
      residentServers: metrics.totals ? metrics.totals.drcp_open_servers : 0,
      busyResidentServers: metrics.totals ? metrics.totals.drcp_busy_servers : 0,
      monitoringAvailable: metrics.available !== false
    },
    connectionClasses: runtime.services.map(service => ({
      service: service.name,
      schema: service.schema,
      connectionClass: service.connectionClass
    })),
    benchmarkRepository: repository
  };
}

module.exports = { validateBackend };
