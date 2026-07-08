const { execFile } = require('child_process');
const sqlclTimeoutMs = 180000;

function sqlclEnv() {
  const env = { ...process.env };
  delete env.ORACLE_HOME;
  delete env.LD_LIBRARY_PATH;
  return env;
}

function parseSqlclJson(output) {
  const start = output.indexOf('{"results"');
  if (start < 0) throw new Error(`SQLcl JSON output not found: ${output.slice(0, 300)}`);
  return JSON.parse(output.slice(start)).results[0].items || [];
}

function parseSqlclJsonDocuments(output) {
  const docs = [];
  let cursor = 0;
  while (true) {
    const start = output.indexOf('{"results"', cursor);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < output.length; i += 1) {
      const ch = output[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          docs.push(JSON.parse(output.slice(start, i + 1)).results[0].items || []);
          cursor = i + 1;
          break;
        }
      }
    }
    if (cursor <= start) break;
  }
  if (!docs.length) throw new Error(`SQLcl JSON output not found: ${output.slice(0, 300)}`);
  return docs;
}

function runJson(connectionName, sql) {
  const script = [
    'set sqlformat json',
    'set feedback off',
    'set heading on',
    `${sql.replace(/;+\s*$/, '')};`,
    'exit'
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = execFile('sql', ['-S', '-name', connectionName], {
      timeout: sqlclTimeoutMs,
      env: sqlclEnv(),
      maxBuffer: 1024 * 1024 * 4
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr || stdout}`));
        return;
      }
      try {
        resolve(parseSqlclJson(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.stdin.end(script);
  });
}

function runJsonMany(connectionName, statements) {
  const script = [
    'set sqlformat json',
    'set feedback off',
    'set heading on',
    ...statements.map(sql => `${sql.replace(/;+\s*$/, '')};`),
    'exit'
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = execFile('sql', ['-S', '-name', connectionName], {
      timeout: sqlclTimeoutMs,
      env: sqlclEnv(),
      maxBuffer: 1024 * 1024 * 8
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr || stdout}`));
        return;
      }
      try {
        resolve(parseSqlclJsonDocuments(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.stdin.end(script);
  });
}

module.exports = { runJson, runJsonMany };
