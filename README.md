# Desmos workspace

Work on your real desmos.com graphs together with Claude. Nothing gets copied or rebuilt: a small userscript (the **bridge**) links a desmos.com graph to a shared store. Claude reads and edits the store from any project thread, and your open tab picks up those changes within about two seconds. Your own edits go back to the store the same way.

```
desmos.com tab  <->  bridge userscript  <->  desmos-bridge Edge Function  <->  Supabase (schema "desmos")  <->  Claude
```

## Install the bridge (once per browser)

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser. In Chrome, open `chrome://extensions`, click Tampermonkey's **Details**, and turn on **Allow User Scripts**.
2. Open the Tampermonkey dashboard, choose **+** (new script), replace everything with the contents of `dist/desmos-bridge.user.js` (or the personal copy Claude gave you, which has your settings filled in), and save.
3. Open any graph on [desmos.com/calculator](https://www.desmos.com/calculator). A **Workspace** panel appears in the bottom-right corner. If it asks for settings, enter:
   - **Workspace URL:** `https://ymcexpnjrciuykvhmkbf.supabase.co/functions/v1/desmos-bridge`
   - **Workspace key:** the key Claude gave you

## Use it

- **Share a graph:** open it and click **Link this graph**. Claude can now see and edit it.
- **Ask Claude** in the project for a change ("add a slider for gravity"). It appears in your tab with a short note and an **Undo** button.
- **Save to your Desmos account** with Ctrl+S as usual. The bridge never saves to your account on its own.
- **Graphs** lists everything in the workspace, including graphs Claude started. **Open** loads one into desmos.com.
- **History** lists every version; **Restore** brings an old one back as the newest version. Nothing is ever deleted.
- **Pause sync** stops syncing in this tab until you resume.

If you and Claude change different lines at the same time, both changes are kept. If you change the same line, Claude's later write wins and the panel says so; Undo brings yours back.

## Repository layout

| Path | What it is |
| --- | --- |
| `bridge/core.cjs` | Pure sync logic: state comparison, line-by-line three-way merge, URL parsing |
| `bridge/userscript.template.js` | The userscript (panel, polling, pushing); `npm run build` inlines the core |
| `dist/desmos-bridge.user.js` | Built userscript to install |
| `supabase/migrations/` | `desmos` schema: `graphs`, `graph_versions`, `bridge_keys`, helper functions |
| `supabase/functions/desmos-bridge/` | Edge Function API the bridge talks to |
| `docs/claude-guide.md` | How Claude reads and edits graphs safely |
| `test/` | Unit, API and end-to-end tests |

## Development

```sh
npm install
npm run build                       # rebuild dist/desmos-bridge.user.js
TEST_DATABASE_URL=postgres://... npm test        # unit + API tests (API tests need a throwaway Postgres)
TEST_DATABASE_URL=postgres://... npm run test:e2e  # Playwright test with a fake Calc
```

Deploy the Edge Function with JWT verification **off**; it checks `x-workspace-key` against SHA-256 hashes in `desmos.bridge_keys`.

Add a key:

```sql
insert into desmos.bridge_keys (label, key_hash)
values ('laptop', encode(sha256(convert_to('<new key>', 'UTF8')), 'hex'));
```

Revoke one: `update desmos.bridge_keys set revoked_at = now() where label = 'laptop';`

## Limits

- Relies on desmos.com exposing its calculator to the page as `Calc`. That is not an official interface; if Desmos changes it, the panel shows an error and leaves your graphs alone.
- Built for the 2D graphing calculator first. 3D and Geometry pages load the bridge but are not tested yet.
