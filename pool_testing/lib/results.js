'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function flattenRows(result) {
  const rows = [];
  for (const experiment of result.experiments) {
    for (const pool of experiment.pools) {
      rows.push({
        run_id: result.runId,
        experiment: experiment.name,
        mode: experiment.mode,
        status: experiment.summary.status,
        pool_id: pool.poolId,
        user: pool.user,
        requested_pool_min: pool.requestedPoolMin,
        requested_pool_max: pool.requestedPoolMax,
        actual_connections_open: pool.actualConnectionsOpen,
        actual_connections_in_use: pool.actualConnectionsInUse,
        time_to_first_connection_ms: pool.timeToFirstConnectionMs,
        time_to_full_warmup_ms: pool.timeToFullWarmupMs,
        full_warmup: pool.fullWarmup,
        create_ms: pool.createMs,
        error_count: pool.errorCount,
        first_error: pool.errors && pool.errors[0] ? pool.errors[0].message : ''
      });
    }
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(','))
  ].join('\n');
}

function reportConclusion(result) {
  const lines = [];
  const serial = result.experiments.find(exp => exp.name === 'five-pools-serial');
  const parallel = result.experiments.find(exp => exp.name === 'five-pools-parallel');
  if (serial && parallel) {
    if (serial.summary.fullWarmup && !parallel.summary.fullWarmup) {
      lines.push('Parallel pool creation behaved worse than serial creation. Concurrent authentication or connection establishment is a likely bottleneck.');
    } else if (!serial.summary.fullWarmup && !parallel.summary.fullWarmup) {
      lines.push('Both serial and parallel pool creation failed to reach the requested target. The total session budget or Autonomous Database service limits may be involved.');
    } else {
      lines.push('Serial and parallel pool creation both reached their requested targets in this run.');
    }
  }
  const single = result.experiments.find(exp => exp.name.startsWith('single-large-'));
  const multiple = result.experiments.find(exp => exp.name.startsWith('multiple-small-'));
  if (single && multiple) {
    if (single.summary.fullWarmup && !multiple.summary.fullWarmup) {
      lines.push('A single larger pool succeeded while multiple smaller pools did not. Multiple pool initialization pressure is more likely than total session count alone.');
    } else if (!single.summary.fullWarmup && !multiple.summary.fullWarmup) {
      lines.push('A single larger pool and multiple smaller pools both failed. Total session availability or service limits are likely candidates.');
    } else {
      lines.push('Single large and multiple small pool layouts both reached their targets.');
    }
  }
  const failures = result.experiments.filter(exp => !exp.summary.fullWarmup || exp.summary.errorCount > 0);
  if (failures.length) {
    lines.push(`${failures.length} experiment(s) had partial warm-up or errors. Review JSON details and Oracle evidence for thresholds.`);
  }
  if (!lines.length) lines.push('All executed experiments reached their requested targets. No pool creation bottleneck was reproduced in this run.');
  return lines;
}

function parseThresholdExperimentName(name) {
  const match = /^threshold-(serial|parallel|demo-like)-5x(\d+)$/.exec(name);
  if (!match) return null;
  return { variant: match[1], size: Number(match[2]) };
}

function thresholdAnalysis(result) {
  const bySize = new Map();
  for (const experiment of result.experiments || []) {
    const parsed = parseThresholdExperimentName(experiment.name);
    if (!parsed) continue;
    if (!bySize.has(parsed.size)) bySize.set(parsed.size, {});
    bySize.get(parsed.size)[parsed.variant] = experiment.summary.status || (experiment.summary.fullWarmup ? 'stable' : 'failed');
  }
  if (!bySize.size) return null;

  const rows = [...bySize.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([size, statuses]) => {
      const values = ['serial', 'parallel', 'demo-like'].map(variant => statuses[variant] || 'not run');
      const stable = values.every(status => status === 'stable' || status === 'not run') && values.some(status => status === 'stable');
      return { size, statuses, stable };
    });
  const stableRows = rows.filter(row => row.stable);
  const highestStable = stableRows.length ? stableRows[stableRows.length - 1].size : 0;
  const firstUnstable = rows.find(row => !row.stable);
  const demoTraditionalMin = highestStable >= 5 ? 5 : highestStable;

  return {
    rows,
    highestStable,
    firstUnstableSize: firstUnstable ? firstUnstable.size : null,
    traditionalRecommendation: {
      poolMin: demoTraditionalMin,
      poolMax: 8,
      reason: demoTraditionalMin >= 2
        ? 'A min of 5 per service is the validated ADB PRO baseline and shows the intended 25 idle dedicated sessions across five services.'
        : 'Use the highest fully stable value observed because the environment did not safely reach min 5.'
    },
    drcpRecommendation: {
      poolMin: 0,
      poolMax: 8,
      reason: 'DRCP client pools should avoid recreating the traditional per-service idle footprint; the shared database-resident pool carries the reusable server capacity.'
    },
    adbRecommendation: highestStable >= 5 && !firstUnstable
      ? 'The regular ADB handled the tested 5x5 threshold sweep. This is the preferred environment for the demo.'
      : 'Keep the demo at or below the highest stable configuration, or scale the ADB service if higher poolMin values or sustained concurrent starts are required.'
  };
}

function aggregateSummary(result) {
  const experiments = result.experiments || [];
  const totals = experiments.reduce((acc, experiment) => {
    const summary = experiment.summary || {};
    acc.requestedConnections += summary.requestedConnections || 0;
    acc.openConnections += summary.openConnections || 0;
    acc.errorCount += summary.errorCount || 0;
    acc.maxTimeToFullWarmupMs = Math.max(acc.maxTimeToFullWarmupMs, summary.maxTimeToFullWarmupMs || 0);
    if (!summary.fullWarmup) acc.partialWarmupExperiments += 1;
    return acc;
  }, {
    experimentCount: experiments.length,
    requestedConnections: 0,
    openConnections: 0,
    maxTimeToFullWarmupMs: 0,
    errorCount: 0,
    partialWarmupExperiments: 0
  });
  totals.fullWarmup = totals.partialWarmupExperiments === 0;
  totals.conclusions = reportConclusion(result);
  const threshold = thresholdAnalysis(result);
  if (threshold) totals.threshold = threshold;
  return totals;
}

function toMarkdown(result) {
  const lines = [];
  lines.push(`# Oracle DRCP Pool Diagnostic Report`);
  lines.push('');
  lines.push(`Run ID: \`${result.runId}\``);
  lines.push(`Started: ${result.startedAt}`);
  lines.push(`Finished: ${result.finishedAt}`);
  lines.push('');
  lines.push('## Configuration');
  lines.push('');
  lines.push('| Setting | Value |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(result.configuration)) {
    lines.push(`| ${key} | ${Array.isArray(value) ? value.join(', ') : value} |`);
  }
  lines.push('');
  lines.push('## Experiment Summary');
  lines.push('');
  lines.push('| Experiment | Mode | Status | Requested | Opened | Full Warm-up | Max Warm-up ms | Errors | Conclusion |');
  lines.push('|---|---|---|---:|---:|---|---:|---:|---|');
  for (const experiment of result.experiments) {
    const s = experiment.summary;
    lines.push(`| ${experiment.name} | ${experiment.mode} | ${s.status || ''} | ${s.requestedConnections} | ${s.openConnections} | ${s.fullWarmup ? 'Yes' : 'No'} | ${s.maxTimeToFullWarmupMs} | ${s.errorCount} | ${s.conclusion} |`);
  }
  lines.push('');
  lines.push('## Pool Details');
  lines.push('');
  lines.push('| Experiment | Pool | User | Requested Min | Requested Max | Open | In Use | First Connection ms | Full Warm-up ms | Errors |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const experiment of result.experiments) {
    for (const pool of experiment.pools) {
      lines.push(`| ${experiment.name} | ${pool.poolId} | ${pool.user || ''} | ${pool.requestedPoolMin} | ${pool.requestedPoolMax} | ${pool.actualConnectionsOpen} | ${pool.actualConnectionsInUse} | ${pool.timeToFirstConnectionMs ?? ''} | ${pool.timeToFullWarmupMs ?? ''} | ${pool.errorCount} |`);
    }
  }
  if (result.summary && result.summary.threshold) {
    const threshold = result.summary.threshold;
    lines.push('');
    lines.push('## Threshold Recommendation');
    lines.push('');
    lines.push('| poolMin per service | Serial | Parallel | Demo-like |');
    lines.push('|---:|---|---|---|');
    for (const row of threshold.rows) {
      lines.push(`| ${row.size} | ${row.statuses.serial || 'not run'} | ${row.statuses.parallel || 'not run'} | ${row.statuses['demo-like'] || 'not run'} |`);
    }
    lines.push('');
    lines.push(`Highest stable tested configuration: 5 pools x poolMin ${threshold.highestStable}.`);
    lines.push(`First unstable or incomplete threshold: ${threshold.firstUnstableSize || 'none observed in this run'}.`);
    lines.push('');
    lines.push(`Recommended Traditional baseline: poolMin=${threshold.traditionalRecommendation.poolMin}, poolMax=${threshold.traditionalRecommendation.poolMax}. ${threshold.traditionalRecommendation.reason}`);
    lines.push(`Recommended DRCP client baseline: poolMin=${threshold.drcpRecommendation.poolMin}, poolMax=${threshold.drcpRecommendation.poolMax}. ${threshold.drcpRecommendation.reason}`);
    lines.push(`ADB recommendation: ${threshold.adbRecommendation}`);
  }
  lines.push('');
  lines.push('## Concise Conclusion');
  lines.push('');
  for (const line of reportConclusion(result)) lines.push(`- ${line}`);
  lines.push('');
  lines.push('## Next Actions');
  lines.push('');
  lines.push('- If failures occur only in parallel experiments, repeat with lower `--pools` and longer `--warmupWaitMs` to isolate concurrent authentication pressure.');
  lines.push('- If failures occur at the same total opened session count across all layouts, validate ADB service limits and consider scaling the ADB service.');
  lines.push('- If node-oracledb open counts disagree with Oracle session evidence, focus on pool materialization and database-side session sampling.');
  return lines.join('\n');
}

function writeOutputs(result, config) {
  const resultsDir = path.join(config.root, 'results');
  const reportsDir = path.join(config.root, 'reports');
  ensureDir(resultsDir);
  ensureDir(reportsDir);
  const jsonPath = path.join(resultsDir, `${result.runId}.json`);
  const csvPath = path.join(resultsDir, `${result.runId}.csv`);
  const reportPath = path.join(reportsDir, `${result.runId}.md`);
  const resultWithSummary = { ...result, summary: aggregateSummary(result) };
  fs.writeFileSync(jsonPath, JSON.stringify(resultWithSummary, null, 2));
  for (const experiment of result.experiments) {
    const experimentPath = path.join(resultsDir, `${result.runId}-${experiment.name}.json`);
    fs.writeFileSync(experimentPath, JSON.stringify({
      runId: result.runId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      configuration: result.configuration,
      experiment
    }, null, 2));
  }
  fs.writeFileSync(csvPath, toCsv(flattenRows(result)));
  fs.writeFileSync(reportPath, toMarkdown(resultWithSummary));
  return { jsonPath, csvPath, reportPath };
}

module.exports = { writeOutputs };
