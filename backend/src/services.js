const { withConnection, record } = require('./db/pools');
const { serviceQueries } = require('./db/queries');
const { runJsonMany } = require('./db/sqlclRunner');
const config = require('./config');

async function runService(serviceName, mode, purity, tag) {
  if (typeof mode === 'object' && mode !== null) {
    purity = mode.purity;
    tag = mode.tag;
  }
  mode = config.executionMode;
  const queries = serviceQueries[serviceName];
  if (!queries) throw new Error(`Unknown service: ${serviceName}`);
  if (config.dbDriver === 'sqlcl') {
    const svc = config.services[serviceName];
    const started = Date.now();
    const requestedTag = tag || svc.defaultTag;
    try {
      const [summary, rows] = await runJsonMany(svc.connectionName, [queries.summary, queries.list]);
      const latencyMs = Date.now() - started;
      record(serviceName, mode, requestedTag, purity || 'POOLED', latencyMs, false);
      return {
        service: serviceName,
        driver: 'sqlcl',
        mode,
        purity,
        tag: requestedTag,
        latencyMs,
        summary: summary[0] || {},
        rows
      };
    } catch (err) {
      record(serviceName, mode, requestedTag, purity || 'POOLED', Date.now() - started, true);
      throw err;
    }
  }
  return withConnection(serviceName, { purity, tag }, async (connection) => {
    const summary = await connection.execute(queries.summary);
    const rows = await connection.execute(queries.list);
    return {
      service: serviceName,
      mode,
      summary: summary.rows[0],
      rows: rows.rows
    };
  });
}

module.exports = { runService };
