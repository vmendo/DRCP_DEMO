#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./lib/config');
const { runExperiment } = require('./lib/experiments');
const { writeOutputs } = require('./lib/results');

async function main() {
  const config = loadConfig(process.argv.slice(2));
  const started = new Date();
  console.log(`Oracle DRCP pool diagnostic started at ${started.toISOString()}`);
  console.log(`Experiment: ${config.experiment}`);
  console.log(`Connect string: ${config.connectString}`);
  console.log(`User: ${config.user}`);
  console.log(`Pool target: min=${config.poolMin}, max=${config.poolMax}, increment=${config.poolIncrement}, pools=${config.poolCount}`);

  const result = await runExperiment(config);
  const outputs = writeOutputs(result, config);

  console.log('');
  console.log('Summary');
  console.log('-------');
  console.log(`Run ID: ${result.runId}`);
  console.log(`Experiments: ${result.experiments.length}`);
  for (const experiment of result.experiments) {
    const totals = experiment.summary;
    console.log(`${experiment.name}: requested=${totals.requestedConnections}, opened=${totals.openConnections}, full=${totals.fullWarmup ? 'yes' : 'no'}, errors=${totals.errorCount}`);
  }
  console.log('');
  console.log(`JSON: ${outputs.jsonPath}`);
  console.log(`CSV: ${outputs.csvPath}`);
  console.log(`Report: ${outputs.reportPath}`);
}

main().catch(err => {
  console.error('Diagnostic failed');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
