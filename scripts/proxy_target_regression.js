/* proxy target rule regression — issue #5.

   The user report was `Chat failed: proxy target must be https` while trying to
   point the app at Ollama, which serves plain http on 127.0.0.1:11434. All
   three hosts demanded https://, so the local-first setup this client is built
   around was the one case it refused.

   The rule now is: https anywhere, http only on loopback. This suite checks
   both halves against the REAL scripts/serve.py (started on a free port), plus
   the decision matrix of the shared helper, because the interesting failures
   are at the edges — a LAN address, a public name that merely starts with
   "127.", a scheme that is neither.

   Run: node scripts/proxy_target_regression.js
   RYZA_SERVE_PY=<path> points the same checks at another copy of the server
   (used to prove this suite actually fails on the old rule). */
'use strict';
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVE = process.env.RYZA_SERVE_PY || path.join(ROOT, 'scripts', 'serve.py');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let failures = 0;
const bad = (m) => { failures++; console.log('  FAIL ' + m); };
const ok = (c, m) => { if (c) console.log('  PASS ' + m); else bad(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

function post(port, query, body, extra) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: port, method: 'POST',
      path: '/_proxy?u=' + encodeURIComponent(query),
      headers: Object.assign({ 'content-type': 'application/json' }, extra || {})
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.end(JSON.stringify(body || { ping: 1 }));
  });
}

function get(port, query, extra) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: port, method: 'GET',
      path: '/_proxy?u=' + encodeURIComponent(query),
      headers: extra || {}
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.end();
  });
}

(async () => {
  /* ---- 1. the decision matrix, straight out of the real module ---- */
  const probe = [
    'import json, sys, importlib.util',
    'spec = importlib.util.spec_from_file_location("serve", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'cases = ["https://api.example.com/v1", "http://127.0.0.1:11434/v1",',
    '         "http://127.5.5.5:8080/", "http://localhost:11434/",',
    '         "http://[::1]:11434/", "http://192.168.1.5:11434/",',
    '         "http://10.0.0.7/", "http://8.8.8.8/", "http://127.0.0.1.evil.com/",',
    '         "http://2130706433/", "ftp://127.0.0.1/", "file:///etc/passwd",',
    '         "http:///nohost", "", "http://user:pass@127.0.0.1:1/",',
    '         "http://127.1:11434/", "http://localhost.evil.com/",',
    '         "http://127.0.0.1:80@evil.com/"]',
    'print(json.dumps({c: m.proxy_target_allowed(c) for c in cases}))'
  ].join('\n');
  const matrix = JSON.parse(execFileSync(PYTHON, ['-c', probe, SERVE], { encoding: 'utf8' }));

  const want = {
    'https://api.example.com/v1': true,
    'http://127.0.0.1:11434/v1': true,
    'http://127.5.5.5:8080/': true,
    'http://localhost:11434/': true,
    'http://[::1]:11434/': true,
    'http://192.168.1.5:11434/': false,
    'http://10.0.0.7/': false,
    'http://8.8.8.8/': false,
    'http://127.0.0.1.evil.com/': false,
    'ftp://127.0.0.1/': false,
    'file:///etc/passwd': false,
    'http:///nohost': false,
    '': false,
    'http://user:pass@127.0.0.1:1/': true
  };
  console.log('=== 1. matrix (scripts/serve.py) ===');
  Object.keys(want).forEach((c) => {
    const got = matrix[c];
    ok(got === want[c], (want[c] ? 'allow ' : 'refuse ') + JSON.stringify(c) +
       (got === want[c] ? '' : '  (got ' + got + ')'));
  });

  /* ---- 1b. the desktop implementation must agree with the python one ----
     Same contract, different runtime (config/layers.json pins the files), so
     the two matrices are compared case by case instead of assumed equal. */
  console.log('\n=== 1b. matrix (desktop/proxy-target.js) agrees ===');
  const desktopRule = require('../desktop/proxy-target');
  Object.keys(want).forEach((c) => {
    const got = desktopRule.proxyTargetAllowed(c);
    ok(got === want[c], 'desktop ' + (want[c] ? 'allow ' : 'refuse ') + JSON.stringify(c) +
       (got === want[c] ? '' : '  (got ' + got + ')'));
  });
  /* Node's URL normalises shorthand IPv4 before the check sees it, python
     compares the literal text. Both ends must land on the same side for the
     canonical forms; the shorthands are asserted separately below. */
  const mustRefuseBothWays = [
    'http://localhost.evil.com/',
    'http://127.0.0.1:80@evil.com/'
  ];
  mustRefuseBothWays.forEach((c) => {
    const py = matrix[c];
    const js = desktopRule.proxyTargetAllowed(c);
    ok(py === false && js === false,
       'both runtimes refuse ' + JSON.stringify(c) + ' (py=' + py + ' js=' + js + ')');
  });

  /* Shorthand loopback spellings (`127.1`, the packed decimal form). WHATWG URL
     canonicalises them to 127.0.0.1 before the desktop check, so allowing them
     is correct there — the bytes really do go to this machine. python and java
     compare the text and refuse, which is the safe direction. Asserted instead
     of assumed, so nobody later "fixes" one side to match the other blindly. */
  console.log('\n=== 1c. shorthand spellings (documented divergence) ===');
  ['http://127.1:11434/', 'http://2130706433/'].forEach((c) => {
    const py = matrix[c];
    const js = desktopRule.proxyTargetAllowed(c);
    ok(py === false && js === true,
       JSON.stringify(c) + ' -> python refuses, desktop allows (py=' + py + ' js=' + js + ')');
  });

  /* ---- 1d. the packaged shell can actually require what main.js requires ----
     electron-builder takes package.json's explicit `files` list, so a module
     missing from it works from source and dies in the installed app — the one
     failure no source-level test would otherwise see. */
  console.log('\n=== 1d. desktop packaging list covers main.js requires ===');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  const listed = new Set(pkg.build.files);
  const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  const localReqs = [...mainSrc.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1]);
  ok(localReqs.length > 0, 'main.js has local requires to check');
  localReqs.forEach((rel) => {
    const file = rel.endsWith('.json') ? rel : rel + '.js';
    ok(listed.has(file), 'package.json files[] lists ' + file);
    ok(fs.existsSync(path.join(ROOT, 'desktop', file)), file + ' exists on disk');
  });

  /* ---- 2. end to end, against the running server ---- */
  const upstreamPort = await freePort();
  const proxyPort = await freePort();
  const upstreamSeen = [];
  const upstream = http.createServer((req, res) => {
    upstreamSeen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echo: 'local engine', url: req.url }));
  });
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

  const srv = spawn(PYTHON, [SERVE], {
    cwd: ROOT, env: Object.assign({}, process.env, { RYZA_PORT: String(proxyPort), NO_PROXY: "*", no_proxy: "*" }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let boot = '';
  srv.stdout.on('data', (d) => { boot += d; });
  srv.stderr.on('data', (d) => { boot += d; });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(100);
    try {
      await new Promise((res, rej) => {
        const s = net.connect(proxyPort, '127.0.0.1');
        s.on('connect', () => { s.end(); res(); });
        s.on('error', rej);
      });
      up = true;
    } catch (e) { /* not yet */ }
  }

  console.log('\n=== 2. through the real /_proxy ===');
  if (!up) {
    bad('serve.py did not start on port ' + proxyPort + ' :: ' + boot.slice(0, 200));
  } else {
    const okLoop = await post(proxyPort, 'http://127.0.0.1:' + upstreamPort + '/v1/chat/completions');
    ok(okLoop.status === 200 && /local engine/.test(okLoop.body),
       'Ollama-shaped http loopback target is proxied (issue #5)');

    const okName = await post(proxyPort, 'http://localhost:' + upstreamPort + '/v1');
    ok(okName.status !== 400, 'http://localhost is not refused by the rule');

    const lan = await post(proxyPort, 'http://192.168.1.5:11434/v1/chat/completions');
    ok(lan.status === 400 && /must be https/.test(lan.body),
       'a LAN address is still refused (loopback-only exception)');

    const pub = await post(proxyPort, 'http://127.0.0.1.evil.com/');
    ok(pub.status === 400, 'a public name starting with "127." is still refused');

    const tls = await post(proxyPort, 'https://127.0.0.1:1/v1');
    ok(tls.status !== 400, 'https targets are unaffected by the new rule');

    /* ---- 3. header passthrough: the Fish `model` header ----
       The CURRENT Fish Audio API names its engine in a header. A proxy that
       forwarded only Authorization silently dropped it, Fish fell back to a
       paid engine, and every synthesis answered 402 "Insufficient API
       credit" — on all three hosts, because all three proxied the request.
       The upstream here reports what it actually received, so this asserts the
       bytes at the far end, not the source of the proxy. */
    const fishPost = await post(proxyPort, 'http://127.0.0.1:' + upstreamPort + '/v1/tts',
      { text: 'x', format: 'wav' },
      { model: 's2.1-pro-free', authorization: 'Bearer k', 'api-key': 'k' });
    const seenPost = upstreamSeen[upstreamSeen.length - 1];
    ok(fishPost.status === 200 && seenPost.headers.model === 's2.1-pro-free',
       'POST: the `model` header reaches the upstream engine (Fish 402 root cause)');
    ok(seenPost.headers.authorization === 'Bearer k' && seenPost.headers['api-key'] === 'k',
       'POST: Authorization and api-key are still forwarded alongside it');

    const fishGet = await get(proxyPort, 'http://127.0.0.1:' + upstreamPort + '/v1/tts',
      { model: 's2.1-pro-free', authorization: 'Bearer k' });
    const seenGet = upstreamSeen[upstreamSeen.length - 1];
    ok(fishGet.status === 200 && seenGet.headers.model === 's2.1-pro-free',
       'GET: the same header is forwarded (Qwen audio pull-back shares this path)');
  }

  srv.kill();
  upstream.close();
  await sleep(150);

  console.log('\n' + (failures ? 'PROXY TARGET: ' + failures + ' FAILURES' : 'PROXY TARGET: ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log('  FAIL harness: ' + (e && e.stack || e));
  console.log('\nPROXY TARGET: 1 FAILURES');
  process.exit(1);
});
