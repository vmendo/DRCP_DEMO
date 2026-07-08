const http = require('http');
const workload = require('../../../config/workload.json');

const port = process.env.PORT || 8080;
const body = JSON.stringify(workload.default);

const req = http.request({
  hostname: 'localhost',
  port,
  path: '/api/load/start',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data));
});

req.on('error', err => {
  console.error(`Load generator failed: ${err.message}`);
  process.exitCode = 1;
});
req.write(body);
req.end();
