// Supabase Edge Function entry point. Deploy with JWT verification off:
// the bridge authenticates with its own `x-workspace-key` header instead,
// checked against hashed keys in desmos.bridge_keys.
import postgres from 'npm:postgres@3.4.5';
import { createHandler } from './handler.js';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3 });

Deno.serve(createHandler({ sql }));
