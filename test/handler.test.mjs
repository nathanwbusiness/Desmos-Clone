// Runs the Edge Function handler against a real Postgres.
// Needs TEST_DATABASE_URL (a throwaway database); skipped otherwise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createHandler } from '../supabase/functions/desmos-bridge/handler.js';

const DB = process.env.TEST_DATABASE_URL;
const KEY = 'test-key-1234567890';
const BASE = 'https://example.supabase.co/functions/v1/desmos-bridge';
let sql;
let handle;

const blank = (list = []) => ({ version: 11, graph: { viewport: { xmin: -10, ymin: -10, xmax: 10, ymax: 10 } }, expressions: { list } });

async function call(method, path, body, key = KEY) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-workspace-key'] = key;
  const res = await handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

before(async () => {
  if (!DB) return;
  sql = postgres(DB, { onnotice: () => {} });
  await sql.unsafe('drop schema if exists desmos cascade');
  for (const file of ['20261120000000_desmos.sql', '20261120010000_desmos_bridge_keys.sql']) {
    await sql.unsafe(readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  }
  await sql`insert into desmos.bridge_keys (label, key_hash) values ('test', encode(sha256(convert_to(${KEY}, 'UTF8')), 'hex'))`;
  await sql`insert into desmos.bridge_keys (label, key_hash, revoked_at) values ('old', encode(sha256(convert_to('revoked-key-1234567890', 'UTF8')), 'hex'), now())`;
  handle = createHandler({ sql });
});

after(async () => {
  if (sql) await sql.end();
});

test('handler round trip', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async (t) => {
  await t.test('rejects a missing or wrong key, allows health and CORS preflight', async () => {
    assert.equal((await call('GET', '/graphs', undefined, null)).status, 401);
    assert.equal((await call('GET', '/graphs', undefined, 'nope')).status, 401);
    assert.equal((await call('GET', '/graphs', undefined, 'wrong-key-1234567890')).status, 401);
    assert.equal((await call('GET', '/graphs', undefined, 'revoked-key-1234567890')).status, 401);
    assert.equal((await call('GET', '/graphs')).status, 200);
    assert.equal((await call('GET', '/health', undefined, null)).status, 200);
    const pre = await handle(new Request(BASE + '/graphs', { method: 'OPTIONS' }));
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://www.desmos.com');
  });

  let id;
  await t.test('links a graph from desmos.com', async () => {
    const r = await call('POST', '/graphs', { name: 'Projectile', desmos_hash: 'abc123', state: blank([{ type: 'expression', id: '1', latex: 'y=x' }]) });
    assert.equal(r.status, 201);
    id = r.body.graph.id;
    assert.equal(r.body.graph.version, 1);
    const again = await call('POST', '/graphs', { name: 'Projectile', desmos_hash: 'abc123', state: blank() });
    assert.equal(again.status, 200);
    assert.equal(again.body.existing, true);
    assert.equal((await call('GET', '/graphs/by-hash/abc123')).body.graph.id, id);
    assert.equal((await call('GET', '/graphs/by-hash/zzz')).status, 404);
  });

  await t.test('validates input', async () => {
    assert.equal((await call('POST', '/graphs', { state: { expressions: {} } })).status, 400);
    assert.equal((await call('POST', '/graphs', { state: blank(), desmos_hash: 'bad hash!' })).status, 400);
    assert.equal((await call('PUT', `/graphs/${id}`, { state: blank() })).status, 400);
    assert.equal((await call('GET', '/graphs/not-a-uuid')).status, 404);
  });

  await t.test('polling with since returns 204 until something changes', async () => {
    assert.equal((await call('GET', `/graphs/${id}?since=1`)).status, 204);
    await sql`select desmos.claude_put_expression(${id}, ${sql.json({ type: 'expression', id: '2', latex: 'y=x^2' })}, 'Claude: added a parabola')`;
    const r = await call('GET', `/graphs/${id}?since=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.graph.version, 2);
    assert.equal(r.body.graph.updated_by, 'claude');
    assert.equal(r.body.graph.note, 'Claude: added a parabola');
    assert.equal(r.body.graph.state.expressions.list.length, 2);
  });

  await t.test('saving with a stale base version returns 409 and the current graph', async () => {
    const stale = await call('PUT', `/graphs/${id}`, { state: blank([{ type: 'expression', id: '1', latex: 'y=3x' }]), base_version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.graph.version, 2);
    const ok = await call('PUT', `/graphs/${id}`, { state: blank([{ type: 'expression', id: '1', latex: 'y=3x' }]), base_version: 2, name: 'Projectile v2' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.graph.version, 3);
    const row = (await call('GET', `/graphs/${id}`)).body.graph;
    assert.equal(row.updated_by, 'nathan');
    assert.equal(row.name, 'Projectile v2');
  });

  await t.test('status and metadata updates keep the version', async () => {
    assert.equal((await call('POST', `/graphs/${id}/status`, { status: 'ok v3' })).status, 200);
    const p = await call('PATCH', `/graphs/${id}`, { desmos_hash: 'newhash9' });
    assert.equal(p.body.graph.version, 3);
    assert.equal(p.body.graph.desmos_hash, 'newhash9');
    assert.equal((await call('GET', `/graphs/${id}?since=3`)).status, 204);
  });

  await t.test('lists graphs without their state', async () => {
    const r = await call('GET', '/graphs');
    assert.equal(r.body.graphs.length, 1);
    assert.equal(r.body.graphs[0].state, undefined);
    assert.equal(r.body.graphs[0].bridge_status, 'ok v3');
  });

  await t.test('version history and restore', async () => {
    const v = await call('GET', `/graphs/${id}/versions`);
    assert.deepEqual(v.body.versions.map((x) => x.version), [3, 2, 1]);
    const one = await call('GET', `/graphs/${id}/versions/2`);
    assert.equal(one.body.version.state.expressions.list.length, 2);
    const r = await call('POST', `/graphs/${id}/restore`, { version: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.body.graph.version, 4);
    assert.equal(r.body.graph.note, 'Restored version 2');
    assert.equal(r.body.graph.state.expressions.list.length, 2);
    assert.equal((await call('POST', `/graphs/${id}/restore`, { version: 99 })).status, 404);
  });
});
