const fs = require('fs');
const path = require('path');
const oracledb = require('oracledb');
const config = require('../backend/src/config');

if (config.oracleClientMode === 'thick') {
  oracledb.initOracleClient({
    libDir: config.oracleClientLibDir || undefined,
    configDir: process.env.TNS_ADMIN
  });
}

function plsqlBlocks(sqlText) {
  const blocks = [];
  const lines = sqlText.split(/\r?\n/);
  let current = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(begin|declare)\b/i.test(trimmed)) inBlock = true;
    if (inBlock) current.push(line);
    if (inBlock && trimmed === '/') {
      current.pop();
      blocks.push(current.join('\n').trim());
      current = [];
      inBlock = false;
    }
  }
  return blocks.filter(Boolean);
}

async function main() {
  const sqlPath = path.join(__dirname, '../sql/40_ords_dashboard_metrics.sql');
  const sqlText = fs.readFileSync(sqlPath, 'utf8');

  const connection = await oracledb.getConnection({
    user: config.admin.user,
    password: config.admin.password || config.servicePassword,
    connectString: config.admin.connectString
  });

  try {
    for (const block of plsqlBlocks(sqlText)) {
      await connection.execute(block);
    }
    await connection.commit();
    console.log('ORDS dashboard metrics endpoints applied.');
  } finally {
    await connection.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
