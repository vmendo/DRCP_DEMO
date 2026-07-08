const state = {
  runtime: null,
  runtimeLegacy: null,
  services: {},
  metrics: null,
  poolMetrics: null,
  validation: null,
  history: [],
  selectedTraditional: null,
  selectedDrcp: null,
  samples: { traditional: [], drcp: [] },
  activeRunId: null,
  activeRunStartedAt: null,
  lastLoadState: 'READY',
  timer: null
};

function qs(id) { return document.getElementById(id); }
function setText(id, value) {
  const el = qs(id);
  if (el) el.textContent = value;
}

async function api(path, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...options, signal: controller.signal });
    if (!res.ok) {
      let message = res.statusText;
      try { message = (await res.json()).error || message; } catch (_) {}
      throw new Error(message);
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function init() {
  bindTabs();
  bindHelp();
  bindActions();
  await loadConfiguration();
  await refreshAll();
  state.timer = setInterval(refreshLive, 2500);
}

function bindTabs() {
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  });
}

function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  document.querySelectorAll('.tab-page').forEach(page => page.classList.toggle('active', page.id === `tab-${name}`));
  if (name === 'results') refreshResults();
  if (name === 'evidence') refreshEvidence();
  if (name === 'setup') refreshSetup();
}

function bindHelp() {
  document.querySelectorAll('.help').forEach((trigger, index) => {
    const text = trigger.getAttribute('title');
    if (!text) return;
    trigger.dataset.help = text;
    trigger.removeAttribute('title');
    trigger.id = trigger.id || `help-trigger-${index}`;
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('tabindex', '0');
  });
  document.addEventListener('click', event => {
    const trigger = event.target.closest('.help');
    if (trigger) {
      event.preventDefault();
      event.stopPropagation();
      showHelp(trigger);
      return;
    }
    closeHelp();
  });
  document.addEventListener('keydown', event => {
    const trigger = event.target.closest('.help');
    if (trigger && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      showHelp(trigger);
    }
    if (event.key === 'Escape') closeHelp();
  });
}

function showHelp(trigger) {
  closeHelp();
  const popover = document.createElement('div');
  popover.className = 'help-popover';
  popover.textContent = trigger.dataset.help;
  document.body.appendChild(popover);
  const rect = trigger.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - popover.offsetWidth - 8);
  const top = rect.bottom + popover.offsetHeight + 8 < window.innerHeight
    ? rect.bottom + 8
    : Math.max(8, rect.top - popover.offsetHeight - 8);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function closeHelp() {
  document.querySelectorAll('.help-popover').forEach(el => el.remove());
}

function bindActions() {
  qs('initializePools').addEventListener('click', initializePools);
  qs('runLoad').addEventListener('click', startLoad);
  qs('stopLoad').addEventListener('click', async () => {
    await api('/api/load/stop', { method: 'POST' });
    await refreshLive();
  });
  qs('refreshNow').addEventListener('click', refreshLive);
  qs('refreshResults').addEventListener('click', refreshResults);
  qs('refreshEvidence').addEventListener('click', refreshEvidence);
  qs('refreshSetup').addEventListener('click', refreshSetup);
  qs('traditionalRunSelect').addEventListener('change', () => selectRun('traditional', qs('traditionalRunSelect').value));
  qs('drcpRunSelect').addEventListener('change', () => selectRun('drcp', qs('drcpRunSelect').value));
  qs('resetBenchmark').addEventListener('click', resetBenchmarkHistory);
}

async function loadConfiguration() {
  const [services, runtime, legacy] = await Promise.all([
    api('/api/services'),
    api('/api/runtime/configuration'),
    api('/api/runtime-config').catch(() => null)
  ]);
  state.services = services;
  state.runtime = runtime;
  state.runtimeLegacy = legacy;
  renderRuntime();
  renderInitialFootprint();
  applyBenchmarkDefaults();
  updateDrcpControls();
}

async function refreshAll() {
  await Promise.all([
    refreshLive(),
    refreshResults(),
    refreshSetup()
  ]);
}

async function refreshLive() {
  const [metrics, poolMetrics] = await Promise.all([
    api('/api/metrics').catch(err => ({ error: err.message, app: {}, load: {} })),
    api('/api/pool-metrics', {}, 12000).catch(err => ({ available: false, error: err.message }))
  ]);
  state.metrics = metrics;
  state.poolMetrics = poolMetrics;
  renderLive(metrics, poolMetrics);
}

function renderRuntime() {
  const runtime = state.runtime;
  const isDrcp = runtime.executionMode === 'drcp';
  document.body.classList.toggle('runtime-drcp', isDrcp);
  document.body.classList.toggle('runtime-traditional', !isDrcp);
  qs('headerModeBadge').textContent = isDrcp ? 'Oracle DRCP' : 'Traditional Pooling';
  qs('modeHero').classList.toggle('drcp', isDrcp);
  qs('modeHero').classList.toggle('traditional', !isDrcp);
  qs('currentModeTitle').textContent = isDrcp ? 'Oracle DRCP' : 'Traditional Pooling';
  qs('currentModeText').textContent = isDrcp
    ? 'The same application is connected through SERVER=POOLED and service-specific DRCP connection classes.'
    : 'The same application is connected through normal dedicated sessions with one client pool per service.';
  qs('serverMode').textContent = runtime.databaseServerMode;
  qs('poolImplementation').textContent = runtime.poolImplementation;
  qs('connectionUrl').textContent = runtime.connectionUrl;
  qs('runtimeSummary').innerHTML = runtimeItems(runtime).map(([label, value]) => `<div><span>${label}</span><strong>${value ?? '-'}</strong></div>`).join('');
  qs('runtimeJson').textContent = JSON.stringify(runtime, null, 2);
  qs('backendConfirmation').innerHTML = `Current Backend: <strong>${isDrcp ? 'Oracle DRCP' : 'Traditional Pooling'}</strong> <span>Connected</span>`;
  qs('switchInstructions').innerHTML = isDrcp
    ? ordered(['Stop the application', 'Run ./run.sh', 'Refresh the page', 'Run the Traditional benchmark'])
    : ordered(['Stop the application', 'Run ./run.sh DRCP', 'Refresh the page', 'Run the DRCP benchmark']);
  updateTimeline('configuration');
}

function runtimeItems(runtime) {
  if (runtime.drcpEnabled) {
    return [
      ['Server mode', runtime.databaseServerMode],
      ['Connection class', runtime.connectionClass],
      ['Session purity', runtime.purity],
      ['Datasource', runtime.datasourceImplementation]
    ];
  }
  return [
    ['Pool implementation', runtime.poolImplementation],
    ['Initial pool size', runtime.initialPoolSize],
    ['Maximum pool size', runtime.maxPoolSize],
    ['Datasource', runtime.datasourceImplementation]
  ];
}

function applyBenchmarkDefaults() {
  const defaults = (state.runtime && state.runtime.benchmarkDefaults) || {};
  if (defaults.concurrency && qs('concurrency')) qs('concurrency').value = defaults.concurrency;
  if (defaults.durationSeconds && qs('duration')) qs('duration').value = defaults.durationSeconds;
  setText('concurrencyNote', `Default ${defaults.concurrency || 6}. Same value must be used in both modes.`);
  setText('durationNote', `Measured phase only. Warm-up: ${defaults.warmupSeconds || 10}s outside results.`);
}

function ordered(items) {
  return `<ol>${items.map(item => `<li>${item}</li>`).join('')}</ol>`;
}

function updateDrcpControls() {
  const enabled = state.runtime && state.runtime.drcpEnabled;
  qs('purity').disabled = !enabled;
  qs('tagStrategy').disabled = !enabled;
  qs('purityNote').textContent = enabled ? 'Sent to backend as DRCP request purity.' : 'Disabled because Traditional mode does not support DRCP purity.';
  qs('tagNote').textContent = enabled ? 'Sent to backend for DRCP session tag matching.' : 'Disabled because Traditional mode does not support DRCP tags.';
}

function renderInitialFootprint() {
  const legacy = state.runtimeLegacy || {};
  const pool = legacy.pool || {};
  const servicesCount = state.runtime ? state.runtime.services.length : Object.keys(state.services).length;
  const traditional = pool.traditional || { min: state.runtime.initialPoolSize, max: state.runtime.maxPoolSize };
  const drcp = pool.drcp || { min: 0, max: state.runtime.maxPoolSize, residentMin: 10, residentMax: 100 };
  qs('initialTraditionalServices').textContent = servicesCount;
  qs('initialTraditionalMin').textContent = traditional.min;
  qs('initialTraditionalMax').textContent = traditional.max;
  qs('initialTraditionalTotal').textContent = servicesCount * Number(traditional.min || 0);
  qs('initialTraditionalPotential').textContent = servicesCount * Number(traditional.max || 0);
  qs('initialDrcpResidentMin').textContent = drcp.residentMin ?? 10;
  qs('initialDrcpResidentMax').textContent = drcp.residentMax ?? drcp.max;
  qs('initialDrcpServices').textContent = servicesCount;
}

function renderLive(metrics, poolMetrics) {
  const load = metrics.load || {};
  setText('loadCompleted', load.completedRequests || 0);
  renderBenchmarkStatus(load);

  if (!poolMetrics.available) {
    setText('dbFootprint', '-');
    setText('activeSessionsKpi', '-');
    setText('idleReusable', '-');
    setText('reuseRatioKpi', '-');
    setText('liveFootprintKpi', '-');
    setText('averageLatencyKpi', '-');
    setText('throughputKpi', '-');
    setText('liveCompletedKpi', '-');
    setText('liveErrorsKpi', '-');
    qs('poolMetricsNote').textContent = `Oracle sample unavailable: ${poolMetrics.error || 'unknown error'}`;
    renderOracleEvidence(poolMetrics);
    return;
  }

  const totals = poolMetrics.totals || {};
  const dedicated = Number(totals.dedicated_sessions || 0);
  const dedicatedActive = Number(totals.dedicated_active_sessions || 0);
  const dedicatedIdle = Number(totals.dedicated_inactive_sessions || 0);
  const drcpResident = Number(totals.drcp_open_servers || totals.pooled_sessions || 0);
  const drcpBusy = Number(totals.drcp_busy_servers || totals.pooled_active_sessions || 0);
  const drcpReusable = Math.max(0, drcpResident - drcpBusy);
  const isDrcp = state.runtime.drcpEnabled;
  const footprint = isDrcp ? drcpResident : dedicated;
  const active = isDrcp ? drcpBusy : dedicatedActive;
  const idleReusable = isDrcp ? drcpReusable : dedicatedIdle;
  const reuseRatio = reuseRatioText(poolMetrics);

  setText('dbFootprint', footprint);
  setText('activeSessionsKpi', active);
  setText('idleReusable', idleReusable);
  setText('reuseRatioKpi', reuseRatio);
  setText('liveFootprintKpi', footprint);
  setText('peakReservedKpi', load.peaks && load.peaks.reservedSessions ? load.peaks.reservedSessions : '-');
  setText('averageLatencyKpi', load.finalMetrics && load.finalMetrics.latencyMs ? `${load.finalMetrics.latencyMs} ms` : (load.samples && load.samples.length ? `${load.samples[load.samples.length - 1].latencyMs || 0} ms` : '-'));
  setText('throughputKpi', load.peaks && load.peaks.throughputRps ? `${load.peaks.throughputRps} rps` : '-');
  setText('liveCompletedKpi', load.completedRequests ?? 0);
  setText('liveErrorsKpi', load.errors ?? 0);
  qs('initialTraditionalCurrent').textContent = dedicated;
  qs('initialDrcpCurrent').textContent = drcpResident;
  qs('traditionalCurrent').textContent = dedicated;
  qs('traditionalActive').textContent = dedicatedActive;
  qs('traditionalIdle').textContent = dedicatedIdle;
  qs('drcpCurrent').textContent = drcpResident;
  qs('drcpActive').textContent = drcpBusy;
  qs('drcpIdle').textContent = drcpReusable;
  updateBars(dedicated, dedicatedActive, dedicatedIdle, drcpResident, drcpBusy, drcpReusable);
  renderDatabaseLimits(poolMetrics.databaseLimits);
  qs('reservedNarrative').textContent = isDrcp
    ? `Oracle DRCP has ${drcpResident} resident/open pooled servers, ${drcpBusy} busy and ${drcpReusable} immediately reusable by any service.`
    : `Traditional Pooling has ${dedicated} reserved dedicated sessions, ${dedicatedActive} active and ${dedicatedIdle} idle.`;
  qs('poolMetricsNote').textContent = `${poolMetrics.note || 'Oracle evidence refreshed.'} Last sample: ${new Date(poolMetrics.collectedAt).toLocaleTimeString()} (${poolMetrics.latencyMs} ms).`;
  renderOracleEvidence(poolMetrics);
}

function reuseRatioText(poolMetrics) {
  const totals = poolMetrics.cpoolTotals || {};
  const requests = Number(totals.requests || 0);
  const hits = Number(totals.hits || 0);
  if (!state.runtime || !state.runtime.drcpEnabled || requests <= 0) return '-';
  return `${Math.round((hits / requests) * 100)}%`;
}

function renderBenchmarkStatus(load) {
  const isDrcp = state.runtime && state.runtime.drcpEnabled;
  const modeLabel = isDrcp ? 'Oracle DRCP Benchmark' : 'Traditional Benchmark';
  const latestForMode = state.history.find(run => run.EXECUTION_MODE === (isDrcp ? 'DRCP' : 'TRADITIONAL'));
  const runNumber = state.history.length + (load.running && !state.activeRunId ? 1 : 0);
  const status = benchmarkStatus(load, latestForMode);
  const backendState = load.state || status.toUpperCase().replace(/\s+/g, '_');
  const runId = state.activeRunId || load.id || (latestForMode && latestForMode.RUN_ID) || 'Ready';
  const startedAt = load.startedAt || state.activeRunStartedAt;
  const activeLifecycle = ['INITIALIZING', 'RUNNING', 'DRAINING', 'SAVING_RESULTS'].includes(backendState);
  const duration = activeLifecycle && startedAt ? elapsedText(startedAt) : (latestForMode && latestForMode.DURATION_MS ? ms(latestForMode.DURATION_MS) : '-');
  setText('currentBenchmarkName', `${modeLabel} ${runNumber ? `Run #${runNumber}` : ''}`.trim());
  setText('actionBenchmarkName', 'DRCP connection pool benchmark');
  setText('actionBenchmarkRunId', runId);
  setText('actionBenchmarkMode', isDrcp ? 'Oracle DRCP' : 'Traditional Pooling');
  setText('actionBenchmarkStatus', status);
  qs('benchmarkStatusBadge').textContent = status;
  qs('benchmarkStatusBadge').className = `status-badge ${status.toLowerCase().replace(/\s+/g, '-')}`;
  qs('benchmarkStatusGrid').innerHTML = [
    ['Benchmark State', status],
    ['Benchmark Run ID', runId],
    ['Stage Description', stageDescription(backendState)],
    ['Elapsed Time', duration],
    ['Execution Mode', isDrcp ? 'Oracle DRCP' : 'Traditional Pooling'],
    ['In-flight Requests', load.inFlightRequests ?? 0],
    ['Results Saved', latestForMode && latestForMode.STATUS === 'COMPLETED' && !activeLifecycle ? 'Yes' : (backendState === 'SAVING_RESULTS' ? 'Saving' : (activeLifecycle ? 'No' : '-'))]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value || '-'}</strong></div>`).join('');
  setText('currentDuration', duration);
  setText('loadCompleted', activeLifecycle ? (load.completedRequests || 0) : ((latestForMode && latestForMode.COMPLETED_REQUESTS) || 0));
  setText('resultsSaved', latestForMode && latestForMode.STATUS === 'COMPLETED' && !activeLifecycle ? 'Yes' : (backendState === 'SAVING_RESULTS' ? 'Saving' : (activeLifecycle ? 'No' : '-')));
  setText('actionResultsSaved', latestForMode && latestForMode.STATUS === 'COMPLETED' && !activeLifecycle ? 'Yes' : (backendState === 'SAVING_RESULTS' ? 'Saving' : (activeLifecycle ? 'No' : '-')));
  setText('benchmarkSummaryText', summaryForStatus(status, isDrcp, load, latestForMode, backendState));
  updateTimeline(stageFromBackendState(backendState, latestForMode));
  if (state.lastLoadState !== backendState && ['COMPLETED', 'FAILED', 'STOPPED'].includes(backendState)) {
    refreshResults().catch(() => {});
  }
  state.lastLoadState = backendState;
}

function benchmarkStatus(load, latestForMode) {
  const stateValue = load.state || '';
  if (stateValue === 'INITIALIZING') return 'Initializing';
  if (stateValue === 'RUNNING') return 'Running';
  if (stateValue === 'DRAINING') return 'Draining';
  if (stateValue === 'SAVING_RESULTS') return 'Saving Results';
  if (stateValue === 'COMPLETED') return 'Completed Successfully';
  if (stateValue === 'FAILED') return 'Failed';
  if (stateValue === 'STOPPED') return 'Stopped';
  if (state.activeRunId && latestForMode && latestForMode.RUN_ID === state.activeRunId && latestForMode.STATUS === 'COMPLETED') return 'Completed Successfully';
  if (latestForMode && latestForMode.STATUS === 'COMPLETED') return 'Completed';
  if (latestForMode && latestForMode.STATUS) return latestForMode.STATUS.charAt(0) + latestForMode.STATUS.slice(1).toLowerCase();
  return 'Ready';
}

function summaryForStatus(status, isDrcp, load, latestForMode, backendState) {
  const mode = isDrcp ? 'Oracle DRCP' : 'Traditional Pooling';
  if (backendState === 'INITIALIZING') return `${mode} benchmark is initializing. No workload has been generated yet.`;
  if (status === 'Running') return `${mode} benchmark is running. Oracle samples are being captured and will be persisted for comparison.`;
  if (backendState === 'DRAINING') return `${mode} benchmark is draining. New requests have stopped, but ${load.inFlightRequests || 0} in-flight requests must finish before results can be saved.`;
  if (backendState === 'SAVING_RESULTS') return `${mode} benchmark has drained. The final Oracle sample has been captured and results are being persisted.`;
  if (status === 'Completed Successfully' || status === 'Completed') {
    const completed = latestForMode && latestForMode.COMPLETED_REQUESTS ? latestForMode.COMPLETED_REQUESTS : load.completedRequests || 0;
    const footprint = latestForMode && latestForMode.PEAK_RESERVED_SESSIONS ? latestForMode.PEAK_RESERVED_SESSIONS : '-';
    const active = latestForMode && latestForMode.PEAK_ACTIVE_SESSIONS ? latestForMode.PEAK_ACTIVE_SESSIONS : 0;
    const idle = latestForMode && latestForMode.PEAK_IDLE_SESSIONS ? latestForMode.PEAK_IDLE_SESSIONS : 0;
    return `${mode} completed ${completed} requests and reserved ${footprint} database-side sessions. ${active} were active at peak sample time and ${idle} were idle or reusable. Results are saved for comparison.`;
  }
  return `${mode} benchmark is ready. Start a run to capture workload, Oracle evidence, and persisted comparison data.`;
}

function stageDescription(backendState) {
  return {
    READY: 'Ready for a benchmark run',
    INITIALIZING: 'Creating a persistent benchmark run',
    RUNNING: 'Generating workload and collecting Oracle samples',
    DRAINING: 'Workload stopped; waiting for in-flight requests and final stable sample',
    SAVING_RESULTS: 'Persisting final benchmark results',
    COMPLETED: 'Results saved and ready for comparison',
    FAILED: 'Benchmark failed; inspect status and logs',
    STOPPED: 'Benchmark was stopped before normal completion'
  }[backendState] || 'Ready for a benchmark run';
}

function stageFromBackendState(backendState, latestForMode) {
  if (backendState === 'INITIALIZING') return 'initialize';
  if (backendState === 'RUNNING') return 'run';
  if (backendState === 'DRAINING' || backendState === 'SAVING_RESULTS') return 'save';
  if (backendState === 'COMPLETED' || (latestForMode && latestForMode.STATUS === 'COMPLETED')) return 'save';
  return 'configuration';
}

function updateTimeline(stage) {
  const steps = [
    ['stepConfiguration', 'configuration'],
    ['stepInitialize', 'initialize'],
    ['stepRun', 'run'],
    ['stepSave', 'save'],
    ['stepSwitch', 'switch'],
    ['stepRunAgain', 'runAgain'],
    ['stepCompare', 'compare']
  ];
  if (!steps.some(([id]) => qs(id))) return;
  const order = steps.map(([, key]) => key);
  const index = Math.max(0, order.indexOf(stage));
  steps.forEach(([id], i) => {
    const el = qs(id);
    if (!el) return;
    el.classList.toggle('done', i < index);
    el.classList.toggle('active', i === index);
  });
}

function updateBars(a, b, c, d, e, f) {
  const max = Math.max(1, a, b, c, d, e, f);
  setBar('traditionalSessionsBar', a, max);
  setBar('traditionalActiveBar', b, max);
  setBar('traditionalIdleBar', c, max);
  setBar('drcpSessionsBar', d, max);
  setBar('drcpActiveBar', e, max);
  setBar('drcpIdleBar', f, max);
}

function setBar(id, value, max) {
  const el = qs(id);
  if (el) el.style.width = `${Math.min(100, Math.round((Number(value || 0) / max) * 100))}%`;
}

function renderDatabaseLimits(limits = {}) {
  const budget = Number((state.runtime && state.runtime.benchmarkDefaults && state.runtime.benchmarkDefaults.connectionBudget) || 40);
  const totals = (state.poolMetrics && state.poolMetrics.totals) || {};
  const current = state.runtime && state.runtime.drcpEnabled
    ? Number(totals.drcp_open_servers || totals.pooled_sessions || limits.allocated_sessions || 0)
    : Number(totals.dedicated_sessions || limits.allocated_sessions || 0);
  const pct = Math.round((current / Math.max(1, budget)) * 100);
  qs('dbSessionLimit').textContent = budget;
  qs('dbSessionCurrent').textContent = current;
  qs('dbSessionPct').textContent = `${pct}%`;
  qs('dbSessionMeter').style.width = `${Math.min(100, Math.max(0, pct))}%`;
  qs('dbSessionSource').textContent = 'Configured connection envelope; Oracle database limit remains in Oracle Evidence.';
  const warning = qs('dbLimitWarning');
  if (warning) {
    const risky = current > budget;
    warning.hidden = !risky;
    warning.textContent = `The current footprint is using ${pct}% of the configured connection envelope. Increase APPLICATION_CONNECTION_BUDGET or reduce pool sizing if this should stay below 100%.`;
  }
}

function renderOracleEvidence(metrics) {
  const evidence = metrics.oracleEvidence || {};
  const totals = metrics.totals || {};
  qs('evidenceTotals').innerHTML = [
    ['Dedicated sessions', totals.dedicated_sessions],
    ['Pooled sessions', totals.pooled_sessions],
    ['Active sessions', totals.active_sessions],
    ['DRCP open servers', totals.drcp_open_servers],
    ['DRCP busy servers', totals.drcp_busy_servers]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value ?? '-'}</strong></div>`).join('');
  renderEvidenceTable('evidenceSession', evidence.sessionFootprint || metrics.rawFootprint || [], [
    ['service_name', 'Service'], ['username', 'Schema'], ['server', 'Server'], ['status', 'Status'], ['sessions', 'Rows']
  ]);
  renderEvidenceTable('evidenceResourceLimit', evidence.resourceLimit || [], [
    ['resource_name', 'Resource'], ['current_utilization', 'Current'], ['max_utilization', 'Max seen'], ['limit_value', 'Limit']
  ]);
  renderEvidenceTable('evidenceCpoolStats', evidence.cpoolStats || metrics.cpoolStats || [], [
    ['pool_name', 'Pool'], ['num_open_servers', 'Open'], ['num_busy_servers', 'Busy'], ['num_requests', 'Requests'], ['num_hits', 'Hits']
  ]);
  renderEvidenceTable('evidenceCpoolConn', evidence.cpoolConnections || metrics.cpoolConnections || [], [
    ['username', 'Schema'], ['cclass_name', 'Class'], ['purity', 'Purity'], ['tag', 'Tag'], ['connection_status', 'Status']
  ]);
  renderEvidenceTable('evidenceCpoolClass', evidence.cpoolClassInfo || metrics.cpoolClassInfo || [], [
    ['pool_name', 'Pool'], ['cclass_name', 'Connection class']
  ]);
}

function renderEvidenceTable(id, rows, columns) {
  const target = qs(id);
  if (!target) return;
  if (!rows || rows.length === 0) {
    target.innerHTML = '<div class="evidence-empty">No rows returned in the current Oracle sample.</div>';
    return;
  }
  const header = columns.map(([, label]) => `<th>${label}</th>`).join('');
  const body = rows.slice(0, 12).map(row => `<tr>${columns.map(([key]) => `<td>${format(row[key])}</td>`).join('')}</tr>`).join('');
  target.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function format(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value);
  return text.length > 52 ? `${text.slice(0, 49)}...` : text;
}

async function refreshResults() {
  state.history = await api('/api/benchmark/runs?limit=30').catch(() => []);
  renderHistory();
  pickDefaultRuns();
  await loadSelectedSamples();
  renderComparison();
  if (state.metrics && state.metrics.load) renderBenchmarkStatus(state.metrics.load);
}

function renderHistory() {
  qs('historyRows').innerHTML = state.history.map(run => `
    <tr>
      <td>${run.STARTED_AT ? new Date(run.STARTED_AT).toLocaleString() : ''}</td>
      <td><span class="badge">${run.EXECUTION_MODE}</span></td>
      <td>${run.STATUS}</td>
      <td>${ms(run.DURATION_MS)}</td>
      <td>${run.COMPLETED_REQUESTS ?? '-'}</td>
      <td>${run.ERRORS ?? '-'}</td>
      <td>${run.PEAK_RESERVED_SESSIONS ?? '-'}</td>
      <td>${run.PEAK_IDLE_SESSIONS ?? '-'}</td>
      <td>${run.P95_LATENCY_MS ? `${run.P95_LATENCY_MS} ms` : '-'}</td>
      <td>${run.PEAK_THROUGHPUT_RPS ?? '-'}</td>
    </tr>
  `).join('') || '<tr><td colspan="10">No benchmark runs persisted yet.</td></tr>';
  fillRunSelect('traditionalRunSelect', 'TRADITIONAL');
  fillRunSelect('drcpRunSelect', 'DRCP');
}

function fillRunSelect(id, mode) {
  const runs = state.history.filter(run => run.EXECUTION_MODE === mode && run.STATUS === 'COMPLETED');
  qs(id).innerHTML = runs.map(run => `<option value="${run.RUN_ID}">${new Date(run.STARTED_AT).toLocaleString()} - ${run.COMPLETED_REQUESTS || 0} requests</option>`).join('') || '<option value="">No completed run</option>';
}

function pickDefaultRuns() {
  const traditional = state.history.find(run => run.EXECUTION_MODE === 'TRADITIONAL' && run.STATUS === 'COMPLETED');
  const drcp = state.history.find(run => run.EXECUTION_MODE === 'DRCP' && run.STATUS === 'COMPLETED');
  state.selectedTraditional = qs('traditionalRunSelect').value || (traditional && traditional.RUN_ID);
  state.selectedDrcp = qs('drcpRunSelect').value || (drcp && drcp.RUN_ID);
}

async function selectRun(mode, runId) {
  if (mode === 'traditional') state.selectedTraditional = runId;
  if (mode === 'drcp') state.selectedDrcp = runId;
  await loadSelectedSamples();
  renderComparison();
}

async function loadSelectedSamples() {
  const [traditionalSamples, drcpSamples] = await Promise.all([
    state.selectedTraditional ? api(`/api/benchmark/runs/${state.selectedTraditional}/samples`).catch(() => []) : [],
    state.selectedDrcp ? api(`/api/benchmark/runs/${state.selectedDrcp}/samples`).catch(() => []) : []
  ]);
  state.samples.traditional = traditionalSamples;
  state.samples.drcp = drcpSamples;
}

function renderComparison() {
  const traditional = state.history.find(run => run.RUN_ID === state.selectedTraditional);
  const drcp = state.history.find(run => run.RUN_ID === state.selectedDrcp);
  const currentMode = state.runtime ? state.runtime.executionMode.toUpperCase() : '';
  const latest = state.history[0];
  qs('historyWarning').textContent = latest && latest.EXECUTION_MODE !== currentMode
    ? `Latest persisted run is ${latest.EXECUTION_MODE}, while the running backend is ${currentMode}. Refresh after restarting the other mode before presenting final comparison.`
    : '';

  if (!traditional || !drcp) {
    const completedCount = state.history.filter(run => run.STATUS === 'COMPLETED').length;
    qs('executiveSummary').textContent = completedCount === 0
      ? 'Run one Traditional benchmark and one Oracle DRCP benchmark to compare results.'
      : 'One completed benchmark mode is available. Run the other mode before comparing results.';
    qs('comparisonTable').innerHTML = comparisonMissingRows();
    renderWinnerSummary(null, null);
    clearComparisonBars();
    showChartMessage('sessionsChart', 'sessionsChartMessage', 'Comparison chart hidden until one completed Traditional run and one completed Oracle DRCP run are available.');
    showChartMessage('latencyChart', 'latencyChartMessage', 'Latency chart hidden until both benchmark modes have persisted sample data.');
    return;
  }

  const tradPeak = Number(traditional.PEAK_RESERVED_SESSIONS || 0);
  const drcpPeak = Number(drcp.PEAK_RESERVED_SESSIONS || 0);
  const reduction = tradPeak > 0 ? Math.max(0, Math.round((1 - (drcpPeak / tradPeak)) * 100)) : 0;
  qs('executiveSummary').textContent = `Traditional peaked at ${tradPeak} reserved dedicated sessions. Oracle DRCP peaked at ${drcpPeak} resident pooled servers. Database footprint reduced by ${reduction}%.`;
  renderWinnerSummary(traditional, drcp);
  qs('comparisonTable').innerHTML = comparisonRows(traditional, drcp);
  setCompareBars(tradPeak, drcpPeak, Number(traditional.PEAK_IDLE_SESSIONS || 0), Number(drcp.PEAK_IDLE_SESSIONS || 0));
  drawChartIfUseful(
    'sessionsChart',
    'sessionsChartMessage',
    state.samples.traditional.map(row => row.RESERVED_SESSIONS),
    state.samples.drcp.map(row => row.RESERVED_SESSIONS),
    'Session footprint chart hidden because one or both selected runs have fewer than two persisted samples.'
  );
  drawChartIfUseful(
    'latencyChart',
    'latencyChartMessage',
    state.samples.traditional.map(row => row.LATENCY_MS),
    state.samples.drcp.map(row => row.LATENCY_MS),
    'Latency chart hidden because one or both selected runs have fewer than two persisted samples.'
  );
  updateTimeline('compare');
}

function comparisonMissingRows() {
  const completed = state.history.filter(run => run.STATUS === 'COMPLETED');
  if (completed.length === 0) {
    return '<tr><td colspan="3">No completed benchmark runs yet. Run Traditional first, then restart in DRCP mode and run again.</td></tr>';
  }
  const traditional = completed.find(run => run.EXECUTION_MODE === 'TRADITIONAL');
  const drcp = completed.find(run => run.EXECUTION_MODE === 'DRCP');
  const rows = [
    ['Completed runs', completed.length, 'Need one Traditional and one Oracle DRCP run'],
    ['Traditional run', traditional ? 'Available' : 'Missing', traditional ? date(traditional.STARTED_AT) : 'Run the app in Traditional mode'],
    ['Oracle DRCP run', drcp ? 'Available' : 'Missing', drcp ? date(drcp.STARTED_AT) : 'Restart with ./run.sh DRCP and run benchmark']
  ];
  return rows.map(row => `<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td></tr>`).join('');
}

function renderWinnerSummary(traditional, drcp) {
  if (!traditional || !drcp) {
    setText('winnerTitle', 'Waiting for both benchmark modes');
    setText('winnerText', 'Run one Traditional benchmark and one Oracle DRCP benchmark to calculate database footprint reduction.');
    setText('sessionsSavedValue', '-');
    setText('peakReductionValue', '-');
    setText('idleReductionValue', '-');
    setText('reuseImprovementValue', '-');
    return;
  }
  const tradPeak = Number(traditional.PEAK_RESERVED_SESSIONS || 0);
  const drcpPeak = Number(drcp.PEAK_RESERVED_SESSIONS || 0);
  const tradIdle = Number(traditional.PEAK_IDLE_SESSIONS || 0);
  const drcpIdle = Number(drcp.PEAK_IDLE_SESSIONS || 0);
  const sessionsSaved = Math.max(0, tradPeak - drcpPeak);
  const peakReduction = tradPeak > 0 ? Math.round((sessionsSaved / tradPeak) * 100) : 0;
  const idleReduction = tradIdle > 0 ? Math.round(Math.max(0, (tradIdle - drcpIdle) / tradIdle) * 100) : 0;
  const reuse = drcp.CONNECTION_REUSE_RATIO !== null && drcp.CONNECTION_REUSE_RATIO !== undefined ? `${drcp.CONNECTION_REUSE_RATIO}%` : 'Oracle evidence';
  setText('winnerTitle', `Oracle DRCP reduced database footprint by ${peakReduction}%`);
  setText('winnerText', `Same application, workload, schemas, business logic, and Oracle Database. DRCP changed only the connection strategy and saved ${sessionsSaved} peak database-side sessions while maintaining comparable execution metrics.`);
  setText('sessionsSavedValue', sessionsSaved);
  setText('peakReductionValue', `${peakReduction}%`);
  setText('idleReductionValue', `${idleReduction}%`);
  setText('reuseImprovementValue', reuse);
}

function comparisonRows(traditional, drcp) {
  const rows = [
    ['Benchmark date', date(traditional.STARTED_AT), date(drcp.STARTED_AT)],
    ['Duration', ms(traditional.DURATION_MS), ms(drcp.DURATION_MS)],
    ['Peak database footprint', traditional.PEAK_RESERVED_SESSIONS, drcp.PEAK_RESERVED_SESSIONS],
    ['Peak active sessions', traditional.PEAK_ACTIVE_SESSIONS, drcp.PEAK_ACTIVE_SESSIONS],
    ['Peak idle / reusable', traditional.PEAK_IDLE_SESSIONS, drcp.PEAK_IDLE_SESSIONS],
    ['Resident servers', traditional.PEAK_RESIDENT_SERVERS, drcp.PEAK_RESIDENT_SERVERS],
    ['Reuse ratio', pct(traditional.CONNECTION_REUSE_RATIO), pct(drcp.CONNECTION_REUSE_RATIO)],
    ['Average latency', `${traditional.AVERAGE_LATENCY_MS || '-'} ms`, `${drcp.AVERAGE_LATENCY_MS || '-'} ms`],
    ['P95 latency', `${traditional.P95_LATENCY_MS || '-'} ms`, `${drcp.P95_LATENCY_MS || '-'} ms`],
    ['Throughput', traditional.PEAK_THROUGHPUT_RPS, drcp.PEAK_THROUGHPUT_RPS],
    ['Completed requests', traditional.COMPLETED_REQUESTS, drcp.COMPLETED_REQUESTS],
    ['Errors', traditional.ERRORS, drcp.ERRORS]
  ];
  return rows.map(row => `<tr><td>${row[0]}</td><td>${row[1] ?? '-'}</td><td>${row[2] ?? '-'}</td></tr>`).join('');
}

function setCompareBars(tradPeak, drcpPeak, tradIdle, drcpIdle) {
  const max = Math.max(1, tradPeak, drcpPeak, tradIdle, drcpIdle);
  setBar('compareTraditionalBar', tradPeak, max);
  setBar('compareDrcpBar', drcpPeak, max);
  setBar('compareIdleBar', tradIdle, max);
  qs('compareTraditionalValue').textContent = tradPeak || '-';
  qs('compareDrcpValue').textContent = drcpPeak || '-';
  qs('compareIdleValue').textContent = `${tradIdle || 0} vs ${drcpIdle || 0}`;
}

function clearComparisonBars() {
  setBar('compareTraditionalBar', 0, 1);
  setBar('compareDrcpBar', 0, 1);
  setBar('compareIdleBar', 0, 1);
  qs('compareTraditionalValue').textContent = '-';
  qs('compareDrcpValue').textContent = '-';
  qs('compareIdleValue').textContent = '-';
}

function showChartMessage(chartId, messageId, message) {
  const chart = qs(chartId);
  const msg = qs(messageId);
  if (chart) {
    chart.innerHTML = '';
    chart.hidden = true;
  }
  if (msg) {
    msg.hidden = false;
    msg.textContent = message;
  }
}

function drawChartIfUseful(chartId, messageId, traditionalValues, drcpValues, message) {
  const enoughData = traditionalValues.filter(value => value !== null && value !== undefined).length >= 2
    && drcpValues.filter(value => value !== null && value !== undefined).length >= 2;
  if (!enoughData) {
    showChartMessage(chartId, messageId, message);
    return;
  }
  const chart = qs(chartId);
  const msg = qs(messageId);
  if (chart) chart.hidden = false;
  if (msg) msg.hidden = true;
  drawChart(chartId, traditionalValues, drcpValues);
}

function drawChart(id, traditionalValues, drcpValues) {
  const svg = qs(id);
  const width = 680;
  const height = 220;
  const max = Math.max(1, ...traditionalValues, ...drcpValues);
  svg.innerHTML = `
    <line x1="30" y1="190" x2="660" y2="190" stroke="#e8e0d8"></line>
    <line x1="30" y1="18" x2="30" y2="190" stroke="#e8e0d8"></line>
    ${polyline(traditionalValues, max, width, height, '#C74634')}
    ${polyline(drcpValues, max, width, height, '#007b6e')}
    <text x="40" y="28" fill="#C74634" font-size="12">Traditional</text>
    <text x="140" y="28" fill="#007b6e" font-size="12">DRCP</text>
  `;
}

function polyline(values, max, width, height, color) {
  if (!values || values.length === 0) return '';
  const step = values.length > 1 ? (width - 70) / (values.length - 1) : 1;
  const points = values.map((value, index) => {
    const x = 30 + (index * step);
    const y = 190 - ((Number(value || 0) / max) * 160);
    return `${x},${y}`;
  }).join(' ');
  return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>`;
}

async function refreshEvidence() {
  state.poolMetrics = await api('/api/pool-metrics', {}, 12000).catch(err => ({ available: false, error: err.message }));
  renderOracleEvidence(state.poolMetrics);
}

async function refreshSetup() {
  state.validation = await api('/api/validation', {}, 12000).catch(err => ({ error: err.message }));
  const v = state.validation;
  const dbOk = Boolean(v.databaseConnectivity && v.databaseConnectivity.ok);
  const repoOk = Boolean(v.benchmarkRepository && v.benchmarkRepository.available);
  const loadIdle = !(state.metrics && state.metrics.load && state.metrics.load.running);
  const ready = dbOk && repoOk && loadIdle && !v.error;
  const readiness = qs('setupReadiness');
  if (readiness) {
    readiness.textContent = ready ? 'Demo Ready' : 'Action Required';
    readiness.className = `readiness-banner ${ready ? 'ready' : 'warn'}`;
  }
  qs('setupStatus').innerHTML = [
    ['Environment ready', ready ? 'Ready' : 'Needs attention', ready ? 'ok' : 'warn'],
    ['Backend mode', state.runtime ? state.runtime.executionMode.toUpperCase() : '-', 'ok'],
    ['Backend health', v.error ? v.error : 'OK', v.error ? 'warn' : 'ok'],
    ['Database connectivity', dbOk ? 'OK' : (v.databaseConnectivity && v.databaseConnectivity.error) || v.error || 'Unknown', dbOk ? 'ok' : 'warn'],
    ['DRCP status', v.drcpStatus ? `${v.drcpStatus.residentServers} resident / ${v.drcpStatus.busyResidentServers} busy` : '-', 'ok'],
    ['Benchmark repository', repoOk ? 'Ready' : 'Unavailable', repoOk ? 'ok' : 'warn'],
    ['Load generator', loadIdle ? 'Idle' : 'Running', loadIdle ? 'ok' : 'warn'],
    ['Oracle version', v.databaseConnectivity && v.databaseConnectivity.oracleVersion, 'ok']
  ].map(([label, value, stateClass]) => `<div class="check-${stateClass}"><span>${label}</span><strong>${value || '-'}</strong></div>`).join('');
}

async function initializePools() {
  const status = qs('actionStatus');
  status.textContent = 'Initializing configured service pools...';
  try {
    const result = await api('/api/pools/initialize', { method: 'POST' }, 90000);
    const rows = result.initialized || [];
    const failed = rows.filter(row => row.error).length;
    status.textContent = failed ? `Initialized ${rows.length - failed}; ${failed} failed.` : `Initialized ${rows.length} pools.`;
    updateTimeline('initialize');
    await refreshLive();
  } catch (err) {
    status.textContent = `Initialization failed: ${err.message}`;
  }
}

async function startLoad() {
  const body = {
    purity: state.runtime.drcpEnabled ? qs('purity').value : null,
    tagStrategy: state.runtime.drcpEnabled ? qs('tagStrategy').value : null,
    concurrency: Number(qs('concurrency').value),
    durationSeconds: Number(qs('duration').value),
    warmupSeconds: Number((state.runtime.benchmarkDefaults && state.runtime.benchmarkDefaults.warmupSeconds) || 10)
  };
  qs('actionStatus').textContent = 'Benchmark starting: warm-up runs first and is excluded from measured results.';
  const run = await api('/api/load/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 90000);
  state.activeRunId = run.id || null;
  state.activeRunStartedAt = run.startedAt || new Date().toISOString();
  updateTimeline('run');
  await refreshLive();
}

async function resetBenchmarkHistory() {
  if (!confirm('Clear persisted benchmark history? This keeps schemas and application data.')) return;
  qs('setupActionStatus').textContent = 'Clearing benchmark history...';
  await api('/api/benchmark/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'CLEAR_BENCHMARK_HISTORY' })
  });
  qs('setupActionStatus').textContent = 'Benchmark history cleared.';
  await refreshResults();
}

function date(value) {
  return value ? new Date(value).toLocaleString() : '-';
}

function ms(value) {
  return value ? `${Math.round(Number(value) / 100) / 10}s` : '-';
}

function elapsedText(startedAt) {
  const started = Date.parse(startedAt);
  if (!started) return '-';
  return `${Math.max(0, Math.round((Date.now() - started) / 1000))}s`;
}

function pct(value) {
  return value === null || value === undefined ? '-' : `${value}%`;
}

init().catch(err => {
  document.body.innerHTML = `<main><section class="card"><div class="panel-title">Frontend initialization failed</div><pre>${err.stack || err.message}</pre></section></main>`;
});
