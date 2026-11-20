// End-to-end test of the built userscript against the real API handler and a
// real Postgres, with a fake `Calc` standing in for desmos.com's calculator.
// Run: TEST_DATABASE_URL=postgres://... npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import { createHandler } from '../../supabase/functions/desmos-bridge/handler.js';

const require = createRequire(import.meta.url);
const DB = process.env.TEST_DATABASE_URL;
const KEY = 'e2e-key-1234567890abcdef';
const root = new URL('../../', import.meta.url);
const userscript = readFileSync(new URL('dist/desmos-bridge.user.js', root), 'utf8');

let sql, server, base, browser;

const startState = () => ({
  version: 11,
  randomSeed: 'seed',
  graph: { viewport: { xmin: -10, ymin: -10, xmax: 10, ymax: 10 } },
  expressions: { list: [{ type: 'expression', id: '1', color: '#2d70b3', latex: 'y=x' }] },
});

// A small stand-in for desmos.com's Calc. setState adds a default field the way
// Desmos normalizes states, to prove the bridge doesn't echo those changes back.
const FAKE_CALC = `
  (function () {
    const clone = (x) => JSON.parse(JSON.stringify(x));
    let state = clone(window.__initialState);
    const undo = [];
    const listeners = [];
    const fire = (user) => listeners.forEach((cb) => setTimeout(() => cb('change', { isUserInitiated: user }), 0));
    window.Calc = {
      getState: () => clone(state),
      setState(s, opts) {
        if (s && s.__broken) throw new Error('Invalid state');
        if (opts && opts.allowUndo) undo.push(clone(state));
        state = clone(s);
        state.graph = Object.assign({ showGrid: true }, state.graph || {});
        fire(false);
      },
      setMathBounds(b) { state.graph.viewport = { xmin: b.left, xmax: b.right, ymin: b.bottom, ymax: b.top }; fire(false); },
      observeEvent(name, cb) { if (name === 'change') listeners.push(cb); },
      undo() { if (undo.length) { state = undo.pop(); fire(true); } },
      __edit(fn) { fn(state); fire(true); },
    };
  })();
`;

// GM_* shims backed by a storage object the test can seed and read back.
const GM_SHIMS = `
  window.__gm = window.__gm || {};
  window.GM_getValue = (k) => (k in window.__gm ? JSON.parse(window.__gm[k]) : undefined);
  window.GM_setValue = (k, v) => { window.__gm[k] = JSON.stringify(v); };
  window.GM_registerMenuCommand = () => {};
  window.unsafeWindow = window;
  window.GM_xmlhttpRequest = (o) => {
    fetch(o.url, { method: o.method, headers: o.headers, body: o.data })
      .then(async (r) => o.onload({ status: r.status, responseText: await r.text() }))
      .catch(() => o.onerror());
  };
`;

function page(initial) {
  return `<!doctype html><html><head><title>Projectile test | Desmos</title></head><body>
    <script>window.__initialState = ${JSON.stringify(initial)};</script></body></html>`;
}

let pageState = startState();

before(async () => {
  if (!DB) return;
  sql = postgres(DB, { onnotice: () => {} });
  await sql.unsafe('drop schema if exists desmos cascade');
  for (const file of ['20261120000000_desmos.sql', '20261120010000_desmos_bridge_keys.sql']) {
    await sql.unsafe(readFileSync(new URL('supabase/migrations/' + file, root), 'utf8'));
  }
  await sql`insert into desmos.bridge_keys (label, key_hash) values ('e2e', encode(sha256(convert_to(${KEY}, 'UTF8')), 'hex'))`;
  const handle = createHandler({ sql });

  server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/calculator')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(pageState));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const response = await handle(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;
  browser = await require('playwright').chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (sql) await sql.end();
});

async function openTab(context, path, gm) {
  const tab = await context.newPage();
  tab.on('pageerror', (e) => console.error('page error:', e.message));
  await tab.addInitScript(({ gm, shims, calc }) => {
    window.__gm = gm;
    // eslint-disable-next-line no-new-func
    new Function(shims)();
    document.addEventListener('DOMContentLoaded', () => new Function(calc)());
  }, { gm, shims: GM_SHIMS, calc: FAKE_CALC });
  await tab.goto(base + path);
  await tab.addScriptTag({ content: userscript });
  currentTab = tab;
  return tab;
}

const settingsGm = () => ({
  apiUrl: JSON.stringify(base + '/functions/v1/desmos-bridge'),
  apiKey: JSON.stringify(KEY),
  panelOpen: JSON.stringify(true),
});

const panelText = (tab) => tab.evaluate(() => document.getElementById('desmos-workspace-bridge').shadowRoot.textContent);
const clickPanel = (tab, label) =>
  tab.evaluate((label) => {
    const btn = [...document.getElementById('desmos-workspace-bridge').shadowRoot.querySelectorAll('button')].find((b) => b.textContent === label);
    if (!btn) throw new Error('no button ' + label);
    btn.click();
  }, label);
const calcState = (tab) => tab.evaluate(() => window.Calc.getState());
const latexes = (s) => s.expressions.list.map((e) => e.latex);

let currentTab = null;
async function waitFor(fn, what, ms = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (currentTab) console.error('bridge log:\n' + (await currentTab.evaluate(() => window.DesmosWorkspaceBridge.log()).catch(() => [])).join('\n'));
  throw new Error('timed out waiting for ' + what + (last !== undefined ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}

const row = async () => (await sql`select * from desmos.graphs limit 1`)[0];

test('bridge end to end', { skip: !DB && 'set TEST_DATABASE_URL to run', timeout: 90000 }, async (t) => {
  const context = await browser.newContext();
  let tab = await openTab(context, '/calculator/abc123', settingsGm());

  await t.test('an unknown graph shows as not linked, then links', async () => {
    await waitFor(async () => (await panelText(tab)).includes('Not linked'), 'Not linked');
    await clickPanel(tab, 'Link this graph');
    await waitFor(async () => (await row())?.desmos_hash === 'abc123', 'row in database');
    const r = await row();
    assert.equal(r.name, 'Projectile test');
    assert.deepEqual(latexes(r.state), ['y=x']);
    await waitFor(async () => (await panelText(tab)).includes('Synced'), 'Synced');
  });

  await t.test('your edits reach the workspace', async () => {
    await tab.evaluate(() => window.Calc.__edit((s) => s.expressions.list.push({ type: 'expression', id: '2', latex: 'y=2' })));
    await waitFor(async () => (await row()).version === 2, 'version 2');
    const r = await row();
    assert.equal(r.updated_by, 'nathan');
    assert.deepEqual(latexes(r.state), ['y=x', 'y=2']);
  });

  await t.test("Claude's edits reach the tab, with a notice and no echo", async () => {
    const id = (await row()).id;
    await sql`select desmos.claude_put_expression(${id}, ${sql.json({ type: 'expression', id: '3', latex: 'y=x^2' })}, 'Claude: added a parabola')`;
    await waitFor(async () => latexes(await calcState(tab)).includes('y=x^2'), 'parabola in tab');
    assert.match(await panelText(tab), /Claude: added a parabola/);
    await new Promise((r) => setTimeout(r, 3500));
    const r = await row();
    assert.equal(r.version, 3, 'the bridge must not push the normalized state back');
    assert.equal(r.bridge_status, 'applied v3');
  });

  await t.test('simultaneous edits to different lines are merged', async () => {
    const id = (await row()).id;
    await sql`select desmos.claude_put_expression(${id}, ${sql.json({ type: 'expression', id: '2', latex: 'y=3' })}, 'Claude: moved the line to y=3')`;
    await tab.evaluate(() => window.Calc.__edit((s) => { s.expressions.list[0].latex = 'y=-x'; }));
    await waitFor(async () => {
      const r = await row();
      return r.updated_by === 'nathan' && latexes(r.state).join('|') === 'y=-x|y=3|y=x^2';
    }, 'merged state in the workspace');
    assert.deepEqual(latexes(await calcState(tab)), ['y=-x', 'y=3', 'y=x^2']);
  });

  await t.test('history restore brings an old version back', async () => {
    await clickPanel(tab, 'History');
    await waitFor(async () => (await panelText(tab)).includes('Version 1'), 'history list');
    const before = (await row()).version;
    await tab.evaluate(() => {
      const items = [...document.getElementById('desmos-workspace-bridge').shadowRoot.querySelectorAll('.item')];
      const v1 = items.find((i) => i.textContent.startsWith('Version 1 '));
      v1.querySelector('button').click();
    });
    await waitFor(async () => latexes(await calcState(tab)).join('|') === 'y=x', 'version 1 in tab');
    const r = await row();
    assert.equal(r.version, before + 1);
    assert.equal(r.note, 'Restored version 1');
  });

  await t.test('a state that will not load is refused and reported', async () => {
    const id = (await row()).id;
    const v = await sql`select desmos.claude_set_state(${id}, ${sql.json({ __broken: true, expressions: { list: [] } })}, 'Claude: broken on purpose') as v`;
    await waitFor(async () => (await row()).bridge_status?.startsWith('rejected v' + v[0].v), 'rejected status');
    assert.deepEqual(latexes(await calcState(tab)), ['y=x']);
    await tab.evaluate(() => window.Calc.__edit((s) => { s.expressions.list[0].latex = 'y=x+1'; }));
    await waitFor(async () => latexes((await row()).state).join('|') === 'y=x+1', 'good state replaces the broken one');
  });

  await t.test('reopening after Claude edited while you were away applies the change', async () => {
    const gm = await tab.evaluate(() => window.__gm);
    await tab.close();
    const r = await row();
    pageState = r.state; // desmos.com shows what you last had
    await sql`select desmos.claude_put_expression(${r.id}, ${sql.json({ type: 'expression', id: '9', latex: 'x=4' })}, 'Claude: added x=4')`;
    tab = await openTab(context, '/calculator/abc123', gm);
    await waitFor(async () => latexes(await calcState(tab)).includes('x=4'), 'x=4 applied on open');
  });

  await t.test('a different copy on a new browser asks which to keep', async () => {
    await tab.close();
    pageState = startState(); // an old saved copy on desmos.com
    tab = await openTab(context, '/calculator/abc123', settingsGm());
    await waitFor(async () => (await panelText(tab)).includes('Which one should both of us use'), 'question');
    const versionBefore = (await row()).version;
    await clickPanel(tab, 'Load workspace copy');
    await waitFor(async () => latexes(await calcState(tab)).includes('x=4'), 'workspace copy loaded');
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await row()).version, versionBefore, 'loading the workspace copy must not create a new version');
  });

  await context.close();
});
