const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { runService } = require('./services');
const { stats, closeAll, initializeStartupPools, getPoolStatus } = require('./db/pools');
const { startLoad, stopLoad, getLoadState } = require('./load/engine');
const { getPoolMetrics } = require('./db/monitoring');
const { getRuntimeConfiguration, getConfigurationComparison } = require('./runtime');
const { validateBackend } = require('./validation');
const { listRuns, listComparisonSummaries, getRun, listSamples, clearBenchmarkHistory, markAbandonedRuns } = require('./db/benchmarkRepository');

const root = path.join(__dirname, '../..');
const frontendRoot = path.join(root, 'frontend');

function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => {
      timer = setTimeout(() => resolve(typeof fallback === 'function' ? fallback() : fallback), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Connection': 'close'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        const err = new Error('Request body too large');
        err.statusCode = 413;
        req.destroy(err);
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        return resolve(JSON.parse(data));
      } catch (err) {
        const parseError = new Error('Invalid JSON request body');
        parseError.statusCode = 400;
        return reject(parseError);
      }
    });
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/services') return json(res, 200, config.services);
    if (url.pathname === '/api/runtime/configuration') return json(res, 200, getRuntimeConfiguration());
    if (url.pathname === '/api/runtime/configuration/diff') return json(res, 200, getConfigurationComparison());
    if (url.pathname === '/api/runtime-config') return json(res, 200, {
      runtime: getRuntimeConfiguration(),
      pool: config.pool,
      databaseSessionLimit: config.databaseSessionLimit,
      servicesCount: Object.keys(config.services).length,
      modeSignals: {
        traditional: 'DEDICATED',
        drcp: 'POOLED'
      }
    });
    if (url.pathname === '/api/metrics') return json(res, 200, { app: stats, load: getLoadState() });
    if (url.pathname === '/api/pool-metrics') return json(res, 200, await getPoolMetrics({ force: true }));
    if (url.pathname === '/api/validation') return json(res, 200, await validateBackend());
    if (url.pathname === '/api/benchmark/status') {
      const [poolMetrics, recentRuns] = await Promise.all([
        withTimeout(
          getPoolMetrics().catch(err => ({ available: false, error: err.message })),
          3000,
          { available: false, error: 'Pool metrics did not complete within benchmark status timeout' }
        ),
        withTimeout(
          listRuns(10).catch(err => ({ available: false, error: err.message })),
          3000,
          { available: false, error: 'Benchmark history did not complete within status timeout' }
        )
      ]);
      return json(res, 200, {
        runtime: getRuntimeConfiguration(),
        benchmark: getLoadState(),
        liveRuntime: {
          poolMetrics,
          currentRuntimeFootprint: poolMetrics && poolMetrics.totals
            ? (config.executionMode === 'drcp'
              ? Number(poolMetrics.totals.drcp_open_servers || poolMetrics.totals.pooled_sessions || 0)
              : Number(poolMetrics.totals.dedicated_sessions || 0))
            : null
        },
        persistedHistory: recentRuns
      });
    }
    if (url.pathname === '/api/benchmark/runs') return json(res, 200, await listRuns(url.searchParams.get('limit') || 20));
    if (url.pathname === '/api/benchmark/comparison-summaries') return json(res, 200, await listComparisonSummaries(url.searchParams.get('limitPerMode') || 5));
    if (url.pathname === '/api/benchmark/reset' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.confirm !== 'CLEAR_BENCHMARK_HISTORY') return json(res, 400, { error: 'Benchmark history reset requires confirm=CLEAR_BENCHMARK_HISTORY' });
      await clearBenchmarkHistory();
      return json(res, 200, { cleared: true });
    }
    if (url.pathname === '/api/pools/initialize' && req.method === 'POST') return json(res, 200, {
      initialized: await initializeStartupPools()
    });
    if (url.pathname === '/api/pools/status') return json(res, 200, getPoolStatus());
    if (url.pathname === '/api/load/start' && req.method === 'POST') return json(res, 202, await startLoad(await readBody(req)));
    if (url.pathname === '/api/load/stop' && req.method === 'POST') return json(res, 200, stopLoad());
    const runSamplesMatch = url.pathname.match(/^\/api\/benchmark\/runs\/([^/]+)\/samples$/);
    if (runSamplesMatch) return json(res, 200, await listSamples(runSamplesMatch[1]));
    const runMatch = url.pathname.match(/^\/api\/benchmark\/runs\/([^/]+)$/);
    if (runMatch) return json(res, 200, await getRun(runMatch[1]));
    const match = url.pathname.match(/^\/api\/service\/([^/]+)$/);
    if (match) {
      return json(res, 200, await runService(
        match[1],
        {
          purity: url.searchParams.get('purity') || config.defaultPurity,
          tag: url.searchParams.get('tag')
        }
      ));
    }
    return serveStatic(url.pathname, res);
  } catch (err) {
    return json(res, err.statusCode || 500, { error: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined });
  }
}

function serveStatic(requestPath, res) {
  const clean = requestPath === '/' ? '/index.html' : requestPath;
  const filePath = path.normalize(path.join(frontendRoot, clean));
  if (!filePath.startsWith(frontendRoot)) return json(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'Not found' });
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'Connection': 'close'
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => route(req, res));
server.listen(config.port, async () => {
  console.log(`DRCP demo running at http://localhost:${config.port} in ${config.executionMode.toUpperCase()} mode`);
  try {
    await markAbandonedRuns();
  } catch (err) {
    console.error(`Could not mark abandoned benchmark runs: ${err.message}`);
  }
  if (config.dbDriver === 'oracledb' && config.pool.initializeOnStart) {
    try {
      const initialized = await initializeStartupPools();
      const ready = initialized.filter(row => row.initialized).length;
      console.log(`Initialized ${ready}/${initialized.length} startup pools for ${config.executionMode.toUpperCase()} mode`);
      for (const row of initialized) {
        if (!row.initialized) {
          console.error(`Startup pool ${row.serviceName} not ready: open=${row.connectionsOpen}/${row.poolMin}${row.error ? ` error=${row.error}` : ''}`);
        }
      }
    } catch (err) {
      console.error(`Startup pool initialization failed: ${err.message}`);
    }
  }
});

process.on('SIGINT', async () => {
  await closeAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeAll();
  process.exit(0);
});
