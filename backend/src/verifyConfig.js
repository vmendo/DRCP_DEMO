const config = require('./config');
console.log(JSON.stringify({
  dbDriver: config.dbDriver,
  oracleClientMode: config.oracleClientMode,
  oracleClientLibDir: config.oracleClientLibDir,
  tnsAdmin: process.env.TNS_ADMIN,
  connectString: config.baseConnectString,
  drcpConnectString: config.drcpConnectString(config.baseConnectString),
  services: Object.keys(config.services),
  pool: config.pool
}, null, 2));
