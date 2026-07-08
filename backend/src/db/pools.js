const config = require('../config');
const { currentPoolConfig, connectionStringForMode } = require('../runtime');
const oracledb = require('oracledb');

if (config.oracleClientMode === 'thick') {
  oracledb.initOracleClient({
    libDir: config.oracleClientLibDir || undefined,
    configDir: process.env.TNS_ADMIN
  });
}

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

const pools = new Map();
const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  errors: 0,
  byService: {},
  recent: []
};

function key(serviceName) {
  return `${config.executionMode}:${serviceName}`;
}

async function applySessionFixup(connection, serviceName, tag, purity) {
  await connection.execute(`begin
    dbms_application_info.set_module(:module_name, :action_name);
    dbms_session.set_identifier(substr(:client_id, 1, 64));
  end;`, {
    module_name: `DRCP_${serviceName.toUpperCase()}`.slice(0, 48),
    action_name: `${purity || 'POOLED'}`.slice(0, 32),
    client_id: tag || 'UNTAGGED'
  });
  connection.tag = tag;
}

async function createServicePool(serviceName) {
  const svc = config.services[serviceName];
  if (!svc) throw new Error(`Unknown service: ${serviceName}`);
  const poolConfig = currentPoolConfig();
  return oracledb.createPool({
    user: svc.schema,
    password: config.servicePassword,
    connectString: connectionStringForMode(),
    // Create with zero physical sessions first. Startup initialization then
    // materializes poolMin with retries and reconfigures the pool to maintain it.
    poolMin: 0,
    poolMax: poolConfig.max,
    poolIncrement: config.pool.increment,
    queueTimeout: 10000
  });
}

function poolOpenConnections(pool) {
  return Number(pool.connectionsOpen ?? pool.connectionsOpenCount ?? 0);
}

function poolInUseConnections(pool) {
  return Number(pool.connectionsInUse ?? pool.connectionsInUseCount ?? 0);
}

function acquireWithTimeout(pool, timeoutMs) {
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out after ${timeoutMs} ms while opening startup pool connections`));
    }, timeoutMs);

    pool.getConnection()
      .then(connection => {
        if (settled) {
          closeConnection(connection, true).catch(() => {});
          return;
        }
        settled = true;
        clearTimeout(timer);
        connection.callTimeout = config.databaseCallTimeoutMs;
        resolve(connection);
      })
      .catch(err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function closeConnection(connection, drop = false) {
  if (!connection) return;
  try {
    if (drop) {
      await connection.close({ drop: true });
      return;
    }
  } catch (err) {
    // Older drivers may not support close({ drop: true }); fall back to close().
  }
  await connection.close().catch(() => {});
}

async function validateConnection(connection) {
  await connection.execute('select 1 as ok from dual');
}

async function trimPoolToMin(pool, poolConfig) {
  let extra = Math.max(0, poolOpenConnections(pool) - poolConfig.min);
  while (extra > 0 && poolInUseConnections(pool) === 0) {
    let connection;
    try {
      connection = await acquireWithTimeout(pool, 2000);
      await closeConnection(connection, true);
    } catch (err) {
      if (connection) await closeConnection(connection, true);
      break;
    }
    extra = Math.max(0, poolOpenConnections(pool) - poolConfig.min);
  }
}

async function materializePoolMin(serviceName, pool, poolConfig) {
  if (poolConfig.min <= 0) return;
  const deadline = Date.now() + config.poolInitializeTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const connections = [];
    let validConnections = 0;
    try {
      for (let i = 0; i < poolConfig.min; i += 1) {
        const connection = await acquireWithTimeout(pool, Math.min(10000, Math.max(1000, deadline - Date.now())));
        try {
          await validateConnection(connection);
          validConnections += 1;
          connections.push({ connection, drop: false });
        } catch (err) {
          lastError = err;
          connections.push({ connection, drop: true });
        }
      }
    } catch (err) {
      lastError = err;
    } finally {
      await Promise.all(connections.map(({ connection, drop }) => closeConnection(connection, drop)));
    }

    if (validConnections >= poolConfig.min && poolOpenConnections(pool) >= poolConfig.min) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (poolOpenConnections(pool) < poolConfig.min) {
    const err = new Error(`${serviceName}: only opened ${poolOpenConnections(pool)}/${poolConfig.min} startup connections${lastError ? `; last error: ${lastError.message}` : ''}`);
    throw err;
  }

  await trimPoolToMin(pool, poolConfig);

  if (typeof pool.reconfigure === 'function') {
    await pool.reconfigure({
      poolMin: poolConfig.min,
      poolMax: poolConfig.max,
      poolIncrement: config.pool.increment
    });
  }
}

async function getPool(serviceName) {
  const poolKey = key(serviceName);
  if (!pools.has(poolKey)) pools.set(poolKey, await createServicePool(serviceName));
  return pools.get(poolKey);
}

async function initializeStartupPools() {
  if (!config.pool.initializeOnStart) return [];
  const created = [];
  for (const serviceName of Object.keys(config.services)) {
    const poolConfig = currentPoolConfig();
    let pool;
    try {
      pool = await getPool(serviceName);
      await materializePoolMin(serviceName, pool, poolConfig);
      const connectionsOpen = poolOpenConnections(pool);
      created.push({
        mode: config.executionMode,
        serviceName,
        poolMin: poolConfig.min,
        poolMax: poolConfig.max,
        connectionsOpen,
        connectionsInUse: poolInUseConnections(pool),
        initialized: connectionsOpen >= poolConfig.min
      });
    } catch (err) {
      created.push({
        mode: config.executionMode,
        serviceName,
        poolMin: poolConfig.min,
        poolMax: poolConfig.max,
        connectionsOpen: pool ? poolOpenConnections(pool) : 0,
        connectionsInUse: pool ? poolInUseConnections(pool) : 0,
        initialized: false,
        error: err.message
      });
    }
  }
  return created;
}

function getPoolStatus() {
  return Object.keys(config.services).map(serviceName => {
    const pool = pools.get(key(serviceName));
    const poolConfig = currentPoolConfig();
    const connectionsOpen = pool ? poolOpenConnections(pool) : 0;
    return {
      mode: config.executionMode,
      serviceName,
      poolMin: poolConfig.min,
      poolMax: poolConfig.max,
      exists: Boolean(pool),
      connectionsOpen,
      connectionsInUse: pool ? poolInUseConnections(pool) : 0,
      initialized: connectionsOpen >= poolConfig.min
    };
  });
}

function purityValue(purity) {
  if ((purity || '').toUpperCase() === 'NEW') return oracledb.PURITY_NEW;
  return oracledb.PURITY_SELF;
}

async function withConnection(serviceName, options, work) {
  const svc = config.services[serviceName];
  const pool = await getPool(serviceName);
  const mode = config.executionMode;
  const isDrcp = mode === 'drcp';
  const tag = isDrcp ? options.tag || svc.defaultTag : null;
  const purity = isDrcp ? options.purity || config.defaultPurity : 'N/A';
  const started = Date.now();
  let connection;
  try {
    connection = await pool.getConnection({
      connectionClass: isDrcp ? svc.connectionClass : undefined,
      tag: isDrcp ? tag : undefined,
      matchAnyTag: isDrcp,
      purity: isDrcp ? purityValue(purity) : undefined
    });
    connection.callTimeout = config.databaseCallTimeoutMs;
    if (isDrcp) {
      await applySessionFixup(connection, serviceName, tag, purity);
    }
    const result = await work(connection);
    record(serviceName, mode, tag, purity, Date.now() - started, false);
    return result;
  } catch (err) {
    record(serviceName, mode, tag, purity, Date.now() - started, true, err.message);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

function record(service, mode, tag, purity, latencyMs, error, errorMessage) {
  stats.requests += 1;
  if (error) stats.errors += 1;
  if (!stats.byService[service]) stats.byService[service] = { requests: 0, errors: 0, totalLatencyMs: 0 };
  stats.byService[service].requests += 1;
  stats.byService[service].errors += error ? 1 : 0;
  stats.byService[service].totalLatencyMs += latencyMs;
  stats.recent.unshift({ at: new Date().toISOString(), service, mode, tag, purity, latencyMs, error, errorMessage });
  stats.recent = stats.recent.slice(0, 40);
}

async function closeAll() {
  for (const pool of pools.values()) {
    try {
      await pool.close(5);
    } catch (err) {
      if (!['NJS-064', 'NJS-065'].includes(err.code)) throw err;
    }
  }
  pools.clear();
}

module.exports = { withConnection, closeAll, stats, record, initializeStartupPools, getPoolStatus };
