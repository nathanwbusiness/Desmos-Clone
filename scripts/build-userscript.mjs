// Builds dist/desmos-bridge.user.js from the template and the shared core.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const template = readFileSync(new URL('bridge/userscript.template.js', root), 'utf8');
const core = readFileSync(new URL('bridge/core.cjs', root), 'utf8');
if (!template.includes('/*__CORE__*/')) throw new Error('template is missing /*__CORE__*/');
// BRIDGE_URL / BRIDGE_KEY prefill the settings; BRIDGE_OUT writes somewhere else
// (use that for a personal copy with a key, which must never be committed).
const url = process.env.BRIDGE_URL ?? 'https://ymcexpnjrciuykvhmkbf.supabase.co/functions/v1/desmos-bridge';
const key = process.env.BRIDGE_KEY ?? '';
const quote = (v) => JSON.stringify(v).slice(1, -1).replace(/'/g, "\\'");
const out = template
  .replace('/*__CORE__*/', () => core.trim())
  .replace('__DEFAULT_URL__', () => quote(url))
  .replace('__DEFAULT_KEY__', () => quote(key));
const target = process.env.BRIDGE_OUT ? new URL(process.env.BRIDGE_OUT, 'file://' + process.cwd() + '/') : new URL('dist/desmos-bridge.user.js', root);
if (!process.env.BRIDGE_OUT) mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(target, out);
console.log('wrote ' + target.pathname + ' (' + out.length + ' bytes)');
