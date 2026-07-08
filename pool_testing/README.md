# Oracle DRCP Pool Diagnostic

This standalone diagnostic investigates where connection pool creation slows down or opens fewer connections than requested in the Oracle DRCP demo environment.

It does not modify the main demo application, benchmark UI, schemas, or existing database objects.

## Setup

Run from this directory:

```bash
cd pool_testing
cp config.example.env config.local.env
```

Edit `config.local.env` or export variables in your shell. Do not commit passwords.

Required values:

- `POOL_TEST_USER`
- `POOL_TEST_PASSWORD`
- `POOL_TEST_CONNECT_STRING`
- `POOL_TEST_TNS_ADMIN`

The script uses the existing `oracledb` dependency from the parent DRCP demo if available.

## Commands

Run all experiments:

```bash
node run.js --experiment all
```

Run individual experiments:

```bash
node run.js --experiment single-growth
node run.js --experiment serial-five
node run.js --experiment parallel-five
node run.js --experiment compare-single-multiple
node run.js --experiment sweep
node run.js --experiment threshold-sweep
```

Override configuration from the command line:

```bash
POOL_TEST_PASSWORD='...' node run.js \
  --experiment parallel-five \
  --user DRCP_CATALOG \
  --connectString YOUR_ADB_TP_ALIAS \
  --poolMin 2 \
  --poolMax 8 \
  --pools 5 \
  --warmupWaitMs 30000 \
  --sampleIntervalMs 1000
```

Use a pooled TNS alias to diagnose DRCP-specific behavior:

```bash
POOL_TEST_PASSWORD='...' node run.js --experiment all --connectString YOUR_ADB_TP_POOLED_ALIAS
```

Run the conservative threshold sweep requested for the demo configuration:

```bash
POOL_TEST_PASSWORD='...' node run.js \
  --experiment threshold-sweep \
  --connectString YOUR_ADB_TP_ALIAS \
  --poolMax 10 \
  --pools 5 \
  --sizes 1,2,3,4,5 \
  --warmupWaitMs 30000 \
  --sampleIntervalMs 500 \
  --demoWarmupRounds 3 \
  --demoWarmupConcurrency 2
```

The threshold sweep uses the five schemas from `../config/services.json` by default when that file is present. Override with `--serviceUsers USER1,USER2,...` if you need a different set.

## Outputs

Each run creates:

- `results/<run-id>.json`
- `results/<run-id>.csv`
- `reports/<run-id>.md`

The report includes:

- requested pool sizes
- actual open connections
- time to first connection
- time to full warm-up
- errors and timeouts
- Oracle session/resource evidence when available
- a concise conclusion

## What to Look For

- If serial creation succeeds but parallel creation fails or slows down, concurrent authentication or connection establishment is likely the bottleneck.
- If one large pool succeeds but five smaller pools fail with the same total target, pressure is likely related to multiple pool initialization rather than total session count.
- If all modes stop growing at the same low total session count, Autonomous Database service limits are likely involved.
- If node-oracledb reports open connections but Oracle evidence shows fewer sessions, the issue is in materialization/validation or stale client-side pool counters.

## Threshold Sweep Interpretation

`threshold-sweep` runs 5 pools at `poolMin` values from the supplied `--sizes` list, normally `1,2,3,4,5`.

For each size it runs:

- serial creation with held validated connections
- parallel creation with held validated connections
- demo-like startup materialization: create with `poolMin=0`, validate enough connections, close them, then reconfigure the pool to maintain `poolMin`

The sweep stops after the first unstable case unless `--stopOnFailure false` is supplied. The Markdown report includes the highest stable threshold and a conservative recommendation for Traditional and DRCP demo defaults.
