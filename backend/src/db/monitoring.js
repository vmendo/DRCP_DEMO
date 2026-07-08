const { runJsonMany } = require('./sqlclRunner');
const oracledb = require('oracledb');
const http = require('http');
const https = require('https');
const config = require('../config');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const serviceNames = {
  DRCP_CATALOG: 'catalog',
  DRCP_INVENTORY: 'inventory',
  DRCP_ORDERS: 'orders',
  DRCP_PAYMENTS: 'payments',
  DRCP_CUSTOMERS: 'customers'
};

const footprintSql = `
select case username
         when 'DRCP_CATALOG' then 'catalog'
         when 'DRCP_INVENTORY' then 'inventory'
         when 'DRCP_ORDERS' then 'orders'
         when 'DRCP_PAYMENTS' then 'payments'
         when 'DRCP_CUSTOMERS' then 'customers'
         else lower(username)
       end as service_name,
       username,
       server,
       status,
       count(*) as sessions
  from v$session
 where username in (
       'DRCP_CATALOG',
       'DRCP_INVENTORY',
       'DRCP_ORDERS',
       'DRCP_PAYMENTS',
       'DRCP_CUSTOMERS'
 )
 group by username, server, status
 order by service_name, server, status`;

const cpoolStatsSql = `
select pool_name,
       num_open_servers,
       num_busy_servers,
       num_requests,
       num_hits,
       num_misses,
       num_waits
  from v$cpool_stats`;

const cpoolClassSql = `
select cclass_name,
       num_requests,
       num_hits,
       num_misses
  from v$cpool_cc_stats
 order by cclass_name`;

const cpoolConnInfoSql = `
select pool_name,
       username,
       cclass_name,
       purity,
       tag,
       connection_status,
       connection_mode,
       numgets
  from v$cpool_conn_info
 where rownum <= 20
 order by username, cclass_name, connection_status`;

const cpoolClassInfoSql = `
select pool_name,
       cclass_name
  from v$cpool_cc_info
 where rownum <= 20
 order by cclass_name`;

const resourceLimitSql = `
select resource_name,
       current_utilization,
       max_utilization,
       initial_allocation,
       limit_value
  from v$resource_limit
 where resource_name = 'sessions'`;

let cachedMetrics = null;
let inFlightMetrics = null;
const cacheTtlMs = 30000;

function emptyServiceRows() {
  return Object.entries(config.services).map(([service, svc]) => ({
    service_name: service,
    username: svc.schema,
    connection_class: svc.connectionClass,
    sessions: 0,
    dedicated_sessions: 0,
    pooled_sessions: 0,
      active_sessions: 0,
      inactive_sessions: 0,
      dedicated_inactive_sessions: 0,
      pooled_inactive_sessions: 0,
      dedicated_active_sessions: 0,
      pooled_active_sessions: 0
  }));
}

function aggregateFootprint(rows) {
  const byService = new Map(emptyServiceRows().map(row => [row.service_name, row]));
  for (const row of rows) {
    const service = row.service_name || serviceNames[row.username] || String(row.username || '').toLowerCase();
    const target = byService.get(service);
    if (!target) continue;
    const sessions = Number(row.sessions || 0);
    target.sessions += sessions;
    if (String(row.server || '').toUpperCase() === 'DEDICATED') target.dedicated_sessions += sessions;
    if (String(row.server || '').toUpperCase() === 'POOLED') target.pooled_sessions += sessions;
    if (String(row.status || '').toUpperCase() === 'ACTIVE') target.active_sessions += sessions;
    if (String(row.status || '').toUpperCase() === 'INACTIVE') target.inactive_sessions += sessions;
    if (String(row.server || '').toUpperCase() === 'DEDICATED' && String(row.status || '').toUpperCase() === 'INACTIVE') target.dedicated_inactive_sessions += sessions;
    if (String(row.server || '').toUpperCase() === 'POOLED' && String(row.status || '').toUpperCase() === 'INACTIVE') target.pooled_inactive_sessions += sessions;
    if (String(row.server || '').toUpperCase() === 'DEDICATED' && String(row.status || '').toUpperCase() === 'ACTIVE') target.dedicated_active_sessions += sessions;
    if (String(row.server || '').toUpperCase() === 'POOLED' && String(row.status || '').toUpperCase() === 'ACTIVE') target.pooled_active_sessions += sessions;
  }
  return Array.from(byService.values());
}

function aggregateCpoolStats(rows) {
  return rows.reduce((totals, row) => {
    totals.open_servers += Number(row.num_open_servers || 0);
    totals.busy_servers += Number(row.num_busy_servers || 0);
    totals.requests += Number(row.num_requests || 0);
    totals.hits += Number(row.num_hits || 0);
    totals.misses += Number(row.num_misses || 0);
    totals.waits += Number(row.num_waits || 0);
    return totals;
  }, {
    open_servers: 0,
    busy_servers: 0,
    requests: 0,
    hits: 0,
    misses: 0,
    waits: 0
  });
}

function normalizeRows(rows) {
  return rows.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
  ));
}

async function fetchOrdsItems(path) {
  const base = config.ordsMetricsBaseUrl.replace(/\/+$/, '');
  const url = `${base}/${path}`;
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: 8000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`ORDS ${path} returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          const payload = JSON.parse(body);
          resolve(normalizeRows(payload.items || []));
        } catch (err) {
          reject(new Error(`ORDS ${path} returned invalid JSON: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`ORDS ${path} timed out`));
    });
    req.on('error', reject);
  });
}

async function fetchOrdsJson(path) {
  const base = config.ordsMetricsBaseUrl.replace(/\/+$/, '');
  const url = `${base}/${path}`;
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: 8000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`ORDS ${path} returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`ORDS ${path} returned invalid JSON: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`ORDS ${path} timed out`));
    });
    req.on('error', reject);
  });
}

async function runOrdsMetrics() {
  const granular = () => Promise.all([
    fetchOrdsItems('session-footprint'),
    fetchOrdsItems('cpool-stats').catch(() => []),
    fetchOrdsItems('cpool-cc-stats').catch(() => []),
    fetchOrdsItems('cpool-conn-info').catch(() => []),
    fetchOrdsItems('cpool-cc-info').catch(() => []),
    fetchOrdsItems('resource-limit').catch(() => [])
  ]);
  try {
    return await granular();
  } catch (granularErr) {
    // Fall back to the aggregate PL/SQL handler if the individual ORDS
    // endpoints are unavailable. The granular endpoints are preferred because
    // they have shown fresher V$SESSION visibility during pool startup.
  }
  try {
    const payload = await fetchOrdsJson('pool-metrics');
    return [
      normalizeRows(payload.sessionFootprint || []),
      normalizeRows(payload.cpoolStats || []),
      normalizeRows(payload.cpoolClasses || []),
      normalizeRows(payload.cpoolConnections || []),
      normalizeRows(payload.cpoolClassInfo || []),
      normalizeRows(payload.resourceLimit || [])
    ];
  } catch (err) {
    throw err;
  }
}

async function runOracleJsonMany(statements) {
  const connection = await oracledb.getConnection({
    user: config.admin.user,
    password: config.admin.password,
    connectString: config.admin.connectString
  });
  try {
    const results = [];
    for (const sql of statements) {
      const result = await connection.execute(sql.replace(/;+\s*$/, ''));
      results.push(normalizeRows(result.rows || []));
    }
    return results;
  } finally {
    await connection.close();
  }
}

async function runMonitoringQueries(statements) {
  if (config.ordsMetricsBaseUrl) return runOrdsMetrics();
  if (config.dbDriver === 'oracledb') return runOracleJsonMany(statements);
  return runJsonMany(process.env.SQLCL_ADMIN_CONNECTION || 'ADMIN_CONNECTION', statements);
}

async function getPoolMetrics(options = {}) {
  if (!options.force && cachedMetrics && Date.now() - cachedMetrics.cachedAtMs < cacheTtlMs) {
    return cachedMetrics.payload;
  }
  if (inFlightMetrics && options.force) return inFlightMetrics;
  if (inFlightMetrics && cachedMetrics) {
    return {
      ...cachedMetrics.payload,
      stale: true,
      note: `${cachedMetrics.payload.note} Refresh in progress; showing the last completed database sample.`
    };
  }
  if (inFlightMetrics) return inFlightMetrics;
  inFlightMetrics = collectPoolMetrics().finally(() => {
    inFlightMetrics = null;
  });
  return inFlightMetrics;
}

async function collectPoolMetrics() {
  const started = Date.now();
  try {
    const [
      footprint = [],
      cpoolStats = [],
      cpoolClasses = [],
      cpoolConnections = [],
      cpoolClassInfo = [],
      resourceLimit = []
    ] = await runMonitoringQueries([
      footprintSql,
      cpoolStatsSql,
      cpoolClassSql,
      cpoolConnInfoSql,
      cpoolClassInfoSql,
      resourceLimitSql
    ]);
    const services = aggregateFootprint(footprint);
    const cpoolTotals = aggregateCpoolStats(cpoolStats);
    const dedicatedSessions = services.reduce((sum, row) => sum + row.dedicated_sessions, 0);
    const pooledSessions = services.reduce((sum, row) => sum + row.pooled_sessions, 0);
    const resourceLimitRow = resourceLimit[0] || {};
    const parsedLimit = Number(resourceLimitRow.limit_value || resourceLimitRow.initial_allocation || 0);
    const sessionLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : config.databaseSessionLimit;
    const allocatedSessions = Number(resourceLimitRow.current_utilization || dedicatedSessions + pooledSessions);
    const payload = {
      available: true,
      collectedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      runtimeDriver: config.dbDriver,
      monitoringSource: config.ordsMetricsBaseUrl ? 'ords' : config.dbDriver,
      note: config.ordsMetricsBaseUrl
        ? 'Oracle monitoring views are exposed through ORDS read-only REST endpoints and proxied by Node for the dashboard.'
        : config.dbDriver === 'sqlcl'
        ? 'Current runtime uses SQLcl fallback connections, so this shows live database sessions during SQLcl request execution. Use DB_DRIVER=oracledb for persistent client pools.'
        : 'Current runtime uses node-oracledb pools; Oracle monitoring views are read through a direct ADMIN connection.',
      totals: {
        sessions: services.reduce((sum, row) => sum + row.sessions, 0),
        dedicated_sessions: dedicatedSessions,
        pooled_sessions: pooledSessions,
        active_sessions: services.reduce((sum, row) => sum + row.active_sessions, 0),
        dedicated_inactive_sessions: services.reduce((sum, row) => sum + row.dedicated_inactive_sessions, 0),
        pooled_inactive_sessions: services.reduce((sum, row) => sum + row.pooled_inactive_sessions, 0),
        dedicated_active_sessions: services.reduce((sum, row) => sum + row.dedicated_active_sessions, 0),
        pooled_active_sessions: services.reduce((sum, row) => sum + row.pooled_active_sessions, 0),
        drcp_open_servers: cpoolTotals.open_servers,
        drcp_busy_servers: cpoolTotals.busy_servers,
        drcp_observed_sessions: pooledSessions
      },
      databaseLimits: {
        session_limit: sessionLimit,
        allocated_sessions: allocatedSessions,
        max_observed_sessions: Number(resourceLimitRow.max_utilization || allocatedSessions),
        utilization_pct: sessionLimit > 0 ? Math.round((allocatedSessions / sessionLimit) * 100) : null,
        source: resourceLimitRow.resource_name ? 'V$RESOURCE_LIMIT' : 'configured fallback'
      },
      services,
      rawFootprint: footprint,
      cpoolTotals,
      cpoolStats,
      cpoolClasses,
      cpoolConnections,
      cpoolClassInfo,
      oracleEvidence: {
        sessionFootprint: footprint.slice(0, 20),
        cpoolStats,
        cpoolConnections,
        cpoolClassInfo,
        resourceLimit
      }
    };
    cachedMetrics = { cachedAtMs: Date.now(), payload };
    return payload;
  } catch (err) {
    const payload = {
      available: false,
      collectedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      runtimeDriver: config.dbDriver,
      monitoringSource: config.ordsMetricsBaseUrl ? 'ords' : config.dbDriver,
      error: err.message,
      note: config.ordsMetricsBaseUrl
        ? 'Pool metrics require the ORDS dashboard endpoints under ORDS_METRICS_BASE_URL.'
        : 'Pool metrics require an ADMIN database connection and SELECT access to V$SESSION and V$CPOOL_* views.'
    };
    cachedMetrics = { cachedAtMs: Date.now(), payload };
    return payload;
  }
}

module.exports = { getPoolMetrics };
