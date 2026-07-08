'use strict';

const https = require('https');
const http = require('http');

function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve(null);
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`Timed out after ${timeoutMs} ms fetching ${url}`));
    });
    req.on('error', reject);
  });
}

async function collectEvidence(config) {
  if (!config.ordsMetricsBaseUrl) return { available: false, source: 'none', note: 'No ORDS metrics base URL configured.' };
  const base = config.ordsMetricsBaseUrl.replace(/\/$/, '');
  try {
    const [poolMetrics, resourceLimit] = await Promise.all([
      fetchJson(`${base}/pool-metrics/`).catch(err => ({ error: err.message })),
      fetchJson(`${base}/resource-limit/`).catch(err => ({ error: err.message }))
    ]);
    return {
      available: true,
      source: 'ords',
      collectedAt: new Date().toISOString(),
      poolMetrics,
      resourceLimit
    };
  } catch (err) {
    return { available: false, source: 'ords', error: err.message };
  }
}

module.exports = { collectEvidence };
