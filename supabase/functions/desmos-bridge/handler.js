// HTTP API for the browser bridge. Runtime-neutral: it takes a postgres.js
// `sql` tag and returns a (Request) => Response function, so the same code
// runs in the Supabase Edge Function (Deno) and in the Node tests.
//
// Routes (all paths are relative to .../functions/v1/desmos-bridge):
//   GET    /graphs                     list graphs (no state)
//   POST   /graphs                     link a new graph {name, calculator, desmos_hash, state}
//   GET    /graphs/by-hash/:hash       graph linked to a desmos.com graph id
//   GET    /graphs/:id?since=N         full graph, or 204 if version <= N
//   PUT    /graphs/:id                 save from the browser {state, base_version, name?, desmos_hash?}
//                                      409 + {graph} when base_version is stale
//   PATCH  /graphs/:id                 rename or attach a desmos hash {name?, desmos_hash?}
//   POST   /graphs/:id/status          report a bridge result {status}
//   GET    /graphs/:id/versions        version list (newest first)
//   GET    /graphs/:id/versions/:v     one old version with its state
//   POST   /graphs/:id/restore         put an old version back {version}
//
// Every request (except /health) needs the header `x-workspace-key`. Keys are
// checked against SHA-256 hashes in desmos.bridge_keys, so a key can be added
// or revoked with SQL and the plain key is never stored.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[A-Za-z0-9_-]{1,64}$/;
const CALCULATORS = new Set(['graphing', '3d', 'geometry']);
const LIST_COLUMNS = 'id, name, calculator, desmos_hash, version, updated_by, note, bridge_status, updated_at';

const CORS = {
  'access-control-allow-origin': 'https://www.desmos.com',
  'access-control-allow-headers': 'content-type, x-workspace-key',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS',
  'access-control-max-age': '86400',
  vary: 'origin',
};

function json(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new HttpError(400, 'state must be an object');
  }
  if (!state.expressions || !Array.isArray(state.expressions.list)) {
    throw new HttpError(400, 'state.expressions.list must be an array');
  }
}

function checkHash(hash) {
  if (hash != null && !HASH.test(hash)) throw new HttpError(400, 'bad desmos_hash');
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

const KEY_CACHE_MS = 60_000;

export function createHandler({ sql }) {
  const one = async (query) => (await query)[0] ?? null;
  const goodKeys = new Map(); // key -> time it was last confirmed

  async function keyIsValid(key) {
    if (typeof key !== 'string' || key.length < 16 || key.length > 200) return false;
    const seen = goodKeys.get(key);
    if (seen && Date.now() - seen < KEY_CACHE_MS) return true;
    const row = await one(sql`
      select 1 as ok from desmos.bridge_keys
       where revoked_at is null
         and key_hash = encode(sha256(convert_to(${key}, 'UTF8')), 'hex')`);
    if (row) goodKeys.set(key, Date.now());
    else goodKeys.delete(key);
    return !!row;
  }

  async function getGraph(id) {
    const row = await one(sql`select * from desmos.graphs where id = ${id}`);
    if (!row) throw new HttpError(404, 'graph not found');
    return row;
  }

  async function route(req, parts, url) {
    const method = req.method;

    if (parts.length === 1 && parts[0] === 'graphs') {
      if (method === 'GET') {
        const rows = await sql`
          select ${sql.unsafe(LIST_COLUMNS)} from desmos.graphs order by updated_at desc limit 200`;
        return json(200, { graphs: rows });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        checkState(body.state);
        checkHash(body.desmos_hash);
        const calculator = body.calculator ?? 'graphing';
        if (!CALCULATORS.has(calculator)) throw new HttpError(400, 'bad calculator');
        const name = String(body.name || 'Untitled graph').slice(0, 200);
        if (body.desmos_hash) {
          const existing = await one(sql`select * from desmos.graphs where desmos_hash = ${body.desmos_hash}`);
          if (existing) return json(200, { graph: existing, existing: true });
        }
        const row = await one(sql`
          insert into desmos.graphs (name, calculator, desmos_hash, state, updated_by, note)
          values (${name}, ${calculator}, ${body.desmos_hash ?? null}, ${sql.json(body.state)}, 'nathan', 'Linked from desmos.com')
          returning *`);
        return json(201, { graph: row });
      }
    }

    if (parts.length === 3 && parts[0] === 'graphs' && parts[1] === 'by-hash' && method === 'GET') {
      checkHash(parts[2]);
      const row = await one(sql`select * from desmos.graphs where desmos_hash = ${parts[2]}`);
      if (!row) throw new HttpError(404, 'no graph linked to that desmos hash');
      return json(200, { graph: row });
    }

    if (parts[0] !== 'graphs' || !UUID.test(parts[1] ?? '')) throw new HttpError(404, 'not found');
    const id = parts[1];

    if (parts.length === 2) {
      if (method === 'GET') {
        const since = url.searchParams.get('since');
        if (since !== null) {
          const meta = await one(sql`select version from desmos.graphs where id = ${id}`);
          if (!meta) throw new HttpError(404, 'graph not found');
          if (meta.version <= Number(since)) return json(204);
        }
        return json(200, { graph: await getGraph(id) });
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        checkState(body.state);
        checkHash(body.desmos_hash);
        if (!Number.isInteger(body.base_version)) throw new HttpError(400, 'base_version must be an integer');
        const name = body.name ? String(body.name).slice(0, 200) : null;
        const row = await one(sql`
          update desmos.graphs
             set state = ${sql.json(body.state)},
                 updated_by = 'nathan',
                 note = 'Edited on desmos.com',
                 name = coalesce(${name}, name),
                 desmos_hash = coalesce(${body.desmos_hash ?? null}, desmos_hash)
           where id = ${id} and version = ${body.base_version}
          returning id, version, updated_at`);
        if (row) return json(200, { graph: row });
        return json(409, { error: 'the workspace copy changed', graph: await getGraph(id) });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        checkHash(body.desmos_hash);
        const name = body.name ? String(body.name).slice(0, 200) : null;
        const row = await one(sql`
          update desmos.graphs
             set name = coalesce(${name}, name),
                 desmos_hash = coalesce(${body.desmos_hash ?? null}, desmos_hash)
           where id = ${id}
          returning ${sql.unsafe(LIST_COLUMNS)}`);
        if (!row) throw new HttpError(404, 'graph not found');
        return json(200, { graph: row });
      }
    }

    if (parts.length === 3 && parts[2] === 'status' && method === 'POST') {
      const body = await readBody(req);
      const status = String(body.status ?? '').slice(0, 500);
      const row = await one(sql`
        update desmos.graphs set bridge_status = ${status}, bridge_status_at = now()
         where id = ${id} returning id`);
      if (!row) throw new HttpError(404, 'graph not found');
      return json(200, { ok: true });
    }

    if (parts.length === 3 && parts[2] === 'versions' && method === 'GET') {
      const rows = await sql`
        select version, updated_by, note, created_at from desmos.graph_versions
         where graph_id = ${id} order by version desc limit 100`;
      return json(200, { versions: rows });
    }

    if (parts.length === 4 && parts[2] === 'versions' && method === 'GET') {
      const v = Number(parts[3]);
      if (!Number.isInteger(v)) throw new HttpError(400, 'bad version');
      const row = await one(sql`
        select * from desmos.graph_versions where graph_id = ${id} and version = ${v}`);
      if (!row) throw new HttpError(404, 'version not found');
      return json(200, { version: row });
    }

    if (parts.length === 3 && parts[2] === 'restore' && method === 'POST') {
      const body = await readBody(req);
      if (!Number.isInteger(body.version)) throw new HttpError(400, 'version must be an integer');
      await getGraph(id);
      const exists = await one(sql`
        select 1 as ok from desmos.graph_versions where graph_id = ${id} and version = ${body.version}`);
      if (!exists) throw new HttpError(404, 'version not found');
      await sql`select desmos.restore_version(${id}, ${body.version}, 'nathan')`;
      return json(200, { graph: await getGraph(id) });
    }

    throw new HttpError(404, 'not found');
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    // Supabase passes /desmos-bridge/... (or /functions/v1/desmos-bridge/...); keep what follows it.
    const path = url.pathname.replace(/^.*?\/desmos-bridge(?=\/|$)/, '');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);

    if (parts.length === 1 && parts[0] === 'health') return json(200, { ok: true });
    try {
      if (!(await keyIsValid(req.headers.get('x-workspace-key')))) {
        return json(401, { error: 'missing or wrong x-workspace-key' });
      }
      return await route(req, parts, url);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'server error' });
    }
  };
}
