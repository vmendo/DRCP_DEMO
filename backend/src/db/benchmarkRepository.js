const oracledb = require('oracledb');
const config = require('../config');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

let adminPool;
let repositoryShapeReady = false;

function adminPassword() {
  return config.admin.password || config.servicePassword;
}

async function withAdminConnection(work) {
  if (!adminPool) {
    adminPool = await oracledb.createPool({
      user: config.admin.user,
      password: adminPassword(),
      connectString: config.admin.connectString,
      poolMin: 1,
      poolMax: 4,
      poolIncrement: 1,
      queueTimeout: 10000
    });
  }
  const connection = await adminPool.getConnection();
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
}

function asJson(value) {
  return value == null ? null : JSON.stringify(value);
}

async function ensureRepositoryShape() {
  if (repositoryShapeReady) return;
  await withAdminConnection(async connection => {
    const addColumn = async (table, column, definition) => {
      const result = await connection.execute(`
        select count(*) as column_count
          from user_tab_cols
         where table_name = upper(:table_name)
           and column_name = upper(:column_name)`, {
        table_name: table,
        column_name: column
      });
      if (Number(result.rows[0].COLUMN_COUNT) === 0) {
        await connection.execute(`alter table ${table} add (${column} ${definition})`);
      }
    };

    await addColumn('drcp_benchmark_runs', 'stop_requested_at', 'timestamp with time zone');
    await addColumn('drcp_benchmark_runs', 'drain_completed_at', 'timestamp with time zone');
    await addColumn('drcp_benchmark_runs', 'save_completed_at', 'timestamp with time zone');
    await addColumn('drcp_benchmark_runs', 'final_reserved_sessions', 'number');
    await addColumn('drcp_benchmark_runs', 'final_active_sessions', 'number');
    await addColumn('drcp_benchmark_runs', 'final_idle_sessions', 'number');
    await addColumn('drcp_benchmark_runs', 'final_resident_servers', 'number');
    await addColumn('drcp_benchmark_runs', 'final_connection_reuse_ratio', 'number');
    await addColumn('drcp_benchmark_runs', 'summary_text', 'varchar2(1000)');
    await addColumn('drcp_benchmark_samples', 'lifecycle_state', 'varchar2(30)');
    await addColumn('drcp_benchmark_samples', 'active_requests', 'number');
    await addColumn('drcp_benchmark_samples', 'in_flight_requests', 'number');
    await addColumn('drcp_benchmark_samples', 'errors', 'number');
    await addColumn('drcp_benchmark_samples', 'current_database_footprint', 'number');

    await connection.execute(`
      begin
        execute immediate 'alter table drcp_benchmark_runs drop constraint drcp_benchmark_runs_status_ck';
      exception
        when others then
          if sqlcode != -2443 then
            raise;
          end if;
      end;`);
    await connection.execute(`
      alter table drcp_benchmark_runs add constraint drcp_benchmark_runs_status_ck
        check (status in ('READY', 'INITIALIZING', 'RUNNING', 'DRAINING', 'SAVING_RESULTS', 'COMPLETED', 'FAILED', 'STOPPED'))`);
  });
  repositoryShapeReady = true;
}

async function createRun(run) {
  await ensureRepositoryShape();
  await withAdminConnection(connection => connection.execute(`
    insert into drcp_benchmark_runs (
      run_id, execution_mode, benchmark_name, application_version, benchmark_version,
      started_at, status, connection_strategy, pool_configuration, connection_class,
      purity, tagging, notes
    ) values (
      :run_id, :execution_mode, :benchmark_name, :application_version, :benchmark_version,
      systimestamp, :status, :connection_strategy, :pool_configuration, :connection_class,
      :purity, :tagging, :notes
    )`, {
    run_id: run.id,
    execution_mode: run.executionMode.toUpperCase(),
    benchmark_name: run.benchmarkName || 'DRCP connection pool benchmark',
    application_version: config.applicationVersion,
    benchmark_version: config.benchmarkVersion,
    status: run.status || 'INITIALIZING',
    connection_strategy: run.connectionStrategy,
    pool_configuration: asJson(run.configuration),
    connection_class: run.connectionClass,
    purity: run.purity,
    tagging: run.tagging,
    notes: run.notes || null
  }));
}

async function insertSample(runId, sample) {
  await ensureRepositoryShape();
  await withAdminConnection(connection => connection.execute(`
    insert into drcp_benchmark_samples (
      run_id, sample_ts, requests_per_sec, latency_ms, reserved_sessions,
      active_sessions, idle_sessions, resident_servers, connection_reuse_ratio,
      lifecycle_state, active_requests, in_flight_requests, errors, current_database_footprint,
      oracle_metrics
    ) values (
      :run_id, systimestamp, :requests_per_sec, :latency_ms, :reserved_sessions,
      :active_sessions, :idle_sessions, :resident_servers, :connection_reuse_ratio,
      :lifecycle_state, :active_requests, :in_flight_requests, :errors, :current_database_footprint,
      :oracle_metrics
    )`, {
    run_id: runId,
    requests_per_sec: sample.requestsPerSec,
    latency_ms: sample.latencyMs,
    reserved_sessions: sample.reservedSessions,
    active_sessions: sample.activeSessions,
    idle_sessions: sample.idleSessions,
    resident_servers: sample.residentServers,
    connection_reuse_ratio: sample.connectionReuseRatio,
    lifecycle_state: sample.lifecycleState,
    active_requests: sample.activeRequests,
    in_flight_requests: sample.inFlightRequests,
    errors: sample.errors,
    current_database_footprint: sample.currentDatabaseFootprint,
    oracle_metrics: asJson(sample.oracleMetrics)
  }));
}

async function updateRunState(runId, status, values = {}) {
  await ensureRepositoryShape();
  const timestampColumn = {
    RUNNING: null,
    DRAINING: 'stop_requested_at',
    SAVING_RESULTS: 'drain_completed_at',
    COMPLETED: 'save_completed_at',
    FAILED: 'save_completed_at',
    STOPPED: 'stop_requested_at'
  }[status];
  const timestampClause = timestampColumn ? `, ${timestampColumn} = coalesce(${timestampColumn}, systimestamp)` : '';
  await withAdminConnection(connection => connection.execute(`
    update drcp_benchmark_runs
       set status = :status,
           notes = coalesce(:notes, notes)
           ${timestampClause}
     where run_id = :run_id`, {
    run_id: runId,
    status,
    notes: values.notes || null
  }));
}

async function finishRun(runId, summary) {
  await ensureRepositoryShape();
  await withAdminConnection(connection => connection.execute(`
    update drcp_benchmark_runs
       set finished_at = systimestamp,
           save_completed_at = coalesce(save_completed_at, systimestamp),
           duration_ms = :duration_ms,
           status = :status,
           total_requests = :total_requests,
           completed_requests = :completed_requests,
           errors = :errors,
           average_latency_ms = :average_latency_ms,
           p95_latency_ms = :p95_latency_ms,
           peak_latency_ms = :peak_latency_ms,
           peak_throughput_rps = :peak_throughput_rps,
           peak_reserved_sessions = :peak_reserved_sessions,
           peak_active_sessions = :peak_active_sessions,
           peak_idle_sessions = :peak_idle_sessions,
           peak_resident_servers = :peak_resident_servers,
           final_reserved_sessions = :final_reserved_sessions,
           final_active_sessions = :final_active_sessions,
           final_idle_sessions = :final_idle_sessions,
           final_resident_servers = :final_resident_servers,
           final_connection_reuse_ratio = :final_connection_reuse_ratio,
           connection_reuse_ratio = :connection_reuse_ratio,
           oracle_metrics = :oracle_metrics,
           summary_text = :summary_text,
           notes = coalesce(:notes, notes)
     where run_id = :run_id`, {
    run_id: runId,
    duration_ms: summary.durationMs,
    status: summary.status,
    total_requests: summary.totalRequests,
    completed_requests: summary.completedRequests,
    errors: summary.errors,
    average_latency_ms: summary.averageLatencyMs,
    p95_latency_ms: summary.p95LatencyMs,
    peak_latency_ms: summary.peakLatencyMs,
    peak_throughput_rps: summary.peakThroughputRps,
    peak_reserved_sessions: summary.peakReservedSessions,
    peak_active_sessions: summary.peakActiveSessions,
    peak_idle_sessions: summary.peakIdleSessions,
    peak_resident_servers: summary.peakResidentServers,
    final_reserved_sessions: summary.finalReservedSessions,
    final_active_sessions: summary.finalActiveSessions,
    final_idle_sessions: summary.finalIdleSessions,
    final_resident_servers: summary.finalResidentServers,
    final_connection_reuse_ratio: summary.finalConnectionReuseRatio,
    connection_reuse_ratio: summary.connectionReuseRatio,
    oracle_metrics: asJson(summary.oracleMetrics),
    summary_text: summary.summaryText,
    notes: summary.notes || null
  }));
}

async function listRuns(limit = 20) {
  return withAdminConnection(async connection => {
    const result = await connection.execute(`
      select run_id, execution_mode, benchmark_name, started_at, finished_at,
             stop_requested_at, drain_completed_at, save_completed_at, duration_ms,
             status, connection_strategy, connection_class, purity, tagging,
             total_requests, completed_requests, errors, average_latency_ms,
             p95_latency_ms, peak_latency_ms, peak_throughput_rps,
             peak_reserved_sessions, peak_active_sessions, peak_idle_sessions,
             peak_resident_servers, final_reserved_sessions, final_active_sessions,
             final_idle_sessions, final_resident_servers, final_connection_reuse_ratio,
             connection_reuse_ratio, summary_text
        from drcp_benchmark_runs
       order by started_at desc
       fetch first :limit rows only`, { limit: Number(limit) });
    return result.rows || [];
  });
}

async function getRun(runId) {
  return withAdminConnection(async connection => {
    const result = await connection.execute(`
      select run_id, execution_mode, benchmark_name, application_version,
             benchmark_version, started_at, finished_at, stop_requested_at,
             drain_completed_at, save_completed_at, duration_ms, status,
             connection_strategy, connection_class, purity, tagging,
             total_requests, completed_requests, errors, average_latency_ms,
             p95_latency_ms, peak_latency_ms, peak_throughput_rps,
             peak_reserved_sessions, peak_active_sessions, peak_idle_sessions,
             peak_resident_servers, final_reserved_sessions, final_active_sessions,
             final_idle_sessions, final_resident_servers, final_connection_reuse_ratio,
             connection_reuse_ratio, summary_text, notes
        from drcp_benchmark_runs
       where run_id = :run_id`, { run_id: runId });
    return result.rows[0] || null;
  });
}

async function listSamples(runId) {
  return withAdminConnection(async connection => {
    const result = await connection.execute(`
      select sample_id, run_id, sample_ts, lifecycle_state, active_requests,
             in_flight_requests, errors, requests_per_sec, latency_ms,
             reserved_sessions, active_sessions, idle_sessions, resident_servers,
             connection_reuse_ratio, current_database_footprint
        from drcp_benchmark_samples
       where run_id = :run_id
       order by sample_ts`, { run_id: runId });
    return result.rows || [];
  });
}

async function listComparisonSummaries(limitPerMode = 5) {
  return withAdminConnection(async connection => {
    const result = await connection.execute(`
      select *
        from (
          select run_id, execution_mode, benchmark_name, started_at, finished_at,
                 status, total_requests, completed_requests, errors,
                 peak_throughput_rps, peak_reserved_sessions, peak_active_sessions,
                 peak_idle_sessions, peak_resident_servers,
                 final_reserved_sessions, final_active_sessions, final_idle_sessions,
                 final_resident_servers, connection_reuse_ratio, summary_text,
                 row_number() over (partition by execution_mode order by started_at desc) as mode_rank
            from drcp_benchmark_runs
           where status in ('COMPLETED', 'STOPPED')
        )
       where mode_rank <= :limit_per_mode
       order by started_at desc`, { limit_per_mode: Number(limitPerMode) });
    return result.rows || [];
  });
}

async function validateRepository() {
  await ensureRepositoryShape();
  return withAdminConnection(async connection => {
    const result = await connection.execute(`
      select table_name
        from user_tables
       where table_name in ('DRCP_BENCHMARK_RUNS', 'DRCP_BENCHMARK_SAMPLES')
       order by table_name`);
    const tables = (result.rows || []).map(row => row.TABLE_NAME);
    return {
      available: tables.includes('DRCP_BENCHMARK_RUNS') && tables.includes('DRCP_BENCHMARK_SAMPLES'),
      tables
    };
  });
}

async function markAbandonedRuns() {
  await ensureRepositoryShape();
  await withAdminConnection(connection => connection.execute(`
    update drcp_benchmark_runs
       set status = 'FAILED',
           finished_at = coalesce(finished_at, systimestamp),
           save_completed_at = coalesce(save_completed_at, systimestamp),
           notes = coalesce(notes || ' ', '') || 'Marked failed because the backend process restarted while the run was active.'
     where status in ('INITIALIZING', 'RUNNING', 'DRAINING', 'SAVING_RESULTS')`));
}

async function clearBenchmarkHistory() {
  await withAdminConnection(async connection => {
    await connection.execute('delete from drcp_benchmark_samples');
    await connection.execute('delete from drcp_benchmark_runs');
  });
}

module.exports = {
  withAdminConnection,
  ensureRepositoryShape,
  createRun,
  insertSample,
  updateRunState,
  finishRun,
  listRuns,
  listComparisonSummaries,
  getRun,
  listSamples,
  validateRepository,
  markAbandonedRuns,
  clearBenchmarkHistory
};
