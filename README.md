# Oracle DRCP Demo

This project demonstrates the difference between traditional client-side connection pools and Oracle Database Resident Connection Pooling (DRCP) for a five-service application.

The demo runs the same workload twice:

1. Traditional pooling: five service-specific node-oracledb pools use dedicated database sessions.
2. Oracle DRCP: the same services use a pooled TNS alias with database-resident pooled servers.

The dashboard compares the live and persisted database footprint so presenters can show how DRCP reduces idle/open database sessions while preserving the same schemas, workload, and business logic.

## Architecture

- Browser UI: static HTML, CSS, and JavaScript in `frontend/`.
- Node.js backend: REST API, static file server, benchmark engine, and Oracle access in `backend/src/`.
- Oracle Database: five isolated schemas plus an admin-owned benchmark repository and ORDS monitoring endpoints.
- ORDS: read-only monitoring endpoints over Oracle dynamic performance views.
- node-oracledb Thick mode: used for both traditional and DRCP runtime paths.

## Demo Modes

Traditional mode:

- Uses `DEMO_CONNECT_STRING`.
- Creates one client-side pool per service.
- Default pool sizing is `TRADITIONAL_POOL_MIN=5`, `TRADITIONAL_POOL_MAX=8`.
- With five services, startup initializes about 25 dedicated database sessions.

Oracle DRCP mode:

- Uses `DEMO_DRCP_CONNECT_STRING`.
- The TNS alias must include `SERVER=POOLED`.
- Client pools use `DRCP_POOL_MIN=0`, `DRCP_POOL_MAX=8`.
- Services keep separate schemas and connection classes while sharing database-resident pooled servers.

## Services

| Service | Schema | DRCP connection class |
|---|---|---|
| Catalog | `DRCP_CATALOG` | `DRCP_DEMO_CATALOG` |
| Inventory | `DRCP_INVENTORY` | `DRCP_DEMO_INVENTORY` |
| Orders | `DRCP_ORDERS` | `DRCP_DEMO_ORDERS` |
| Payments | `DRCP_PAYMENTS` | `DRCP_DEMO_PAYMENTS` |
| Customers | `DRCP_CUSTOMERS` | `DRCP_DEMO_CUSTOMERS` |

## Prerequisites

- Oracle Autonomous Database or another Oracle Database environment with DRCP support.
- ORDS enabled for the monitoring endpoints.
- Oracle Instant Client available to node-oracledb Thick mode.
- Node.js 18 or later.
- SQLcl for setup scripts.
- An Oracle wallet or equivalent network configuration for your database.

## Configure the Oracle Wallet

Do not commit wallet files.

1. Download your wallet from your Oracle Database service.
2. Extract it outside source control, or under `wallet/` locally. The `wallet/` directory is ignored by Git.
3. Ensure `tnsnames.ora` contains:
   - a normal alias, for example `YOUR_ADB_TP_ALIAS`
   - a pooled alias, for example `YOUR_ADB_TP_POOLED_ALIAS`, whose connect data includes `SERVER=POOLED`
4. Set `DEMO_TNS_ADMIN` in `config/demo.env` to the wallet directory.

See [wallet/README.md](wallet/README.md) for a template.

## Database Setup

Create the five service schemas from an admin SQLcl connection:

```bash
sql -name ADMIN_CONNECTION
SQL> define drcp_schema_password = "your_service_schema_password"
SQL> @sql/01_create_service_schemas.sql
```

Load the service data model:

```bash
sql -name DRCP_CATALOG @sql/10_catalog_model.sql
sql -name DRCP_CUSTOMERS @sql/11_customers_model.sql
sql -name DRCP_INVENTORY @sql/12_inventory_model.sql
sql -name DRCP_ORDERS @sql/13_orders_model.sql
sql -name DRCP_PAYMENTS @sql/14_payments_model.sql
```

Verify each schema:

```bash
sql -name DRCP_CATALOG @sql/20_verify_demo_model.sql
sql -name DRCP_CUSTOMERS @sql/20_verify_demo_model.sql
sql -name DRCP_INVENTORY @sql/20_verify_demo_model.sql
sql -name DRCP_ORDERS @sql/20_verify_demo_model.sql
sql -name DRCP_PAYMENTS @sql/20_verify_demo_model.sql
```

Create the benchmark repository and ORDS monitoring endpoints from an admin SQLcl connection:

```bash
sql -name ADMIN_CONNECTION @sql/50_benchmark_repository.sql
sql -name ADMIN_CONNECTION @sql/40_ords_dashboard_metrics.sql
```

Optional monitoring check:

```bash
sql -name ADMIN_CONNECTION @sql/30_admin_drcp_monitoring.sql
```

## Application Configuration

Create local runtime configuration:

```bash
cp config/demo.env.example config/demo.env
```

Edit `config/demo.env` and provide your own values:

- `DEMO_CONNECT_STRING`: normal TNS alias.
- `DEMO_DRCP_CONNECT_STRING`: pooled TNS alias with `SERVER=POOLED`.
- `DEMO_TNS_ADMIN`: wallet directory.
- `DRCP_PASSWORD`: password for the five service schemas.
- `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_CONNECT_STRING`: admin connection used for the benchmark repository fallback.
- `ORDS_METRICS_BASE_URL`: ORDS base URL created by `sql/40_ords_dashboard_metrics.sql`.

The checked-in file is only a template. Do not commit `config/demo.env`.

## Install and Run

Install dependencies:

```bash
npm install
```

Start in Traditional mode:

```bash
./run.sh
```

Start in Oracle DRCP mode:

```bash
./run.sh DRCP
```

In Autonomous Database, the database-resident DRCP pool can remain warm after
the Node process stops. The benchmark captures a DRCP baseline at run start and
persists DRCP footprint as incremental workload demand over that baseline. This
keeps repeated DRCP runs comparable even when `V$CPOOL_STATS` still shows
resident servers opened by an earlier run.

Open:

```text
http://localhost:8080
```

## Execute the Benchmark

1. Start the app in Traditional mode.
2. Open the Benchmark page.
3. Verify the initial database footprint is about 25 dedicated sessions.
4. Run the benchmark with the default workload.
5. Stop the app.
6. Start the app in DRCP mode.
7. Run the same benchmark.
8. Use the Benchmark Comparison tab to compare persisted results.

## Reset the Demo

Reset benchmark history from the Demo Setup page, or use the API:

```bash
curl -X POST http://localhost:8080/api/benchmark/reset \
  -H 'Content-Type: application/json' \
  -d '{"confirm":"CLEAR_BENCHMARK_HISTORY"}'
```

To reset database objects, rerun the schema/model SQL scripts for your environment.

## Project Structure

```text
backend/       Node.js REST API, benchmark engine, Oracle database access
config/        Runtime templates and service/workload metadata
frontend/      Dashboard, story, architecture, and component pages
pool_testing/  Standalone pool diagnostic utility
scripts/       Helper scripts
sql/           Schema, model, benchmark repository, and ORDS setup scripts
wallet/        Local-only wallet directory, ignored by Git
```

## Included REST Endpoints

Application endpoints:

- `GET /api/runtime/configuration`
- `GET /api/runtime/configuration/diff`
- `GET /api/runtime-config`
- `GET /api/services`
- `GET /api/metrics`
- `GET /api/pool-metrics`
- `POST /api/load/start`
- `POST /api/load/stop`
- `GET /api/benchmark/runs`
- `GET /api/benchmark/comparison-summaries`
- `GET /api/benchmark/runs/:id`
- `GET /api/benchmark/runs/:id/samples`
- `POST /api/benchmark/reset`
- `GET /api/service/:name`

ORDS endpoints created by `sql/40_ords_dashboard_metrics.sql`:

- `/ords/admin/drcp-demo/dashboard/pool-metrics`
- `/ords/admin/drcp-demo/dashboard/session-footprint`
- `/ords/admin/drcp-demo/dashboard/cpool-stats`
- `/ords/admin/drcp-demo/dashboard/cpool-cc-stats`
- `/ords/admin/drcp-demo/dashboard/cpool-conn-info`
- `/ords/admin/drcp-demo/dashboard/cpool-cc-info`
- `/ords/admin/drcp-demo/dashboard/resource-limit`

## Pool Diagnostics

The optional `pool_testing/` utility checks whether the database environment can support the intended pool baseline.

```bash
cd pool_testing
cp config.example.env config.local.env
# edit config.local.env
node run.js --experiment threshold-sweep
```

Generated diagnostic reports and result files are ignored by Git.

## Limitations

- This is a demo, not a production deployment template.
- The UI assumes a single backend process at a time.
- ORDS monitoring visibility depends on database privileges and what the database service exposes.
- DRCP counters can differ by Oracle Database service and version; the dashboard falls back to `V$SESSION.SERVER = POOLED` when aggregate DRCP views are unavailable.
- Wallets, environment files, benchmark result exports, and prompt history are intentionally excluded from source control.

## License

No license file is included yet. Add a license before publishing if this repository should be reusable as open source.
