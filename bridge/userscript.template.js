// ==UserScript==
// @name         Desmos Workspace Bridge
// @namespace    https://github.com/nathanwbusiness/desmos-clone
// @version      0.1.0
// @description  Live-sync desmos.com graphs with your shared workspace so Claude can edit them with you.
// @match        https://www.desmos.com/calculator*
// @match        https://www.desmos.com/3d*
// @match        https://www.desmos.com/geometry*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      supabase.co
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Built file: edit bridge/userscript.template.js and bridge/core.cjs, then run `npm run build`.

/*__CORE__*/

(function () {
  'use strict';

  const core = BridgeCore;
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const POLL_MS = 2000;          // check for Claude's changes while the tab is visible
  const POLL_HIDDEN_MS = 15000;  // ...and while it is in the background
  const PUSH_DELAY_MS = 1200;    // wait this long after your last edit before saving
  const RETRY_MS = 10000;        // when the workspace can't be reached

  // ---------------------------------------------------------------- storage
  const store = {
    get(key, fallback) {
      try {
        const v = GM_getValue(key);
        return v === undefined ? fallback : v;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try { GM_setValue(key, value); } catch (e) { /* storage full or blocked */ }
    },
  };
  // Filled in by the build (npm run build); the panel's Settings override them.
  const DEFAULT_URL = '__DEFAULT_URL__';
  const DEFAULT_KEY = '__DEFAULT_KEY__';
  const settings = () => ({
    url: String(store.get('apiUrl', '') || DEFAULT_URL).trim().replace(/\/+$/, ''),
    key: String(store.get('apiKey', '') || DEFAULT_KEY).trim(),
  });
  // Per graph, the last version and state this browser agreed on with the workspace.
  const syncRecord = (id) => store.get('sync:' + id, null);
  const saveSyncRecord = (id, version, state) => store.set('sync:' + id, { version, state });

  // -------------------------------------------------------------------- api
  function api(method, path, body) {
    const { url, key } = settings();
    return new Promise((resolve, reject) => {
      if (!url || !key) return reject(new Error('Workspace URL or key is missing'));
      GM_xmlhttpRequest({
        method,
        url: url + path,
        headers: { 'content-type': 'application/json', 'x-workspace-key': key },
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: 20000,
        onload(res) {
          let data = null;
          try { data = res.responseText ? JSON.parse(res.responseText) : null; } catch (e) { /* not JSON */ }
          resolve({ status: res.status, data });
        },
        onerror() { reject(new Error('network error')); },
        ontimeout() { reject(new Error('timed out')); },
      });
    });
  }

  // Like api(), but never throws: returns null and shows "offline" instead.
  async function safeApi(method, path, body) {
    try {
      const r = await api(method, path, body);
      if (r.status === 401) {
        setStatus('error', 'Wrong workspace key. Open Settings.');
        return null;
      }
      if (!S.online) { S.online = true; setStatus('ok'); }
      return r;
    } catch (err) {
      S.online = false;
      setStatus('offline', 'Workspace unreachable, retrying');
      return null;
    }
  }

  // ------------------------------------------------------------------ state
  const S = {
    calc: null,
    link: null,        // { id, name, hash, calculator, version, base, updatedBy, note, updatedAt }
    paused: false,
    applying: false,
    pushing: false,
    pushAgain: false,
    pushTimer: null,
    pollTimer: null,
    online: true,
    lastPath: location.pathname,
  };

  // Recent bridge events, for troubleshooting: DesmosWorkspaceBridge.log() in the console.
  const events = [];
  function log(...args) {
    events.push(new Date().toISOString().slice(11, 23) + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    if (events.length > 200) events.shift();
  }

  const currentHash = () => (core.parseDesmosPath(location.pathname) || {}).hash || null;

  function setStatus(kind, text) {
    ui.status(kind, text);
  }

  // ------------------------------------------------------------------- boot
  function waitForCalc() {
    return new Promise((resolve) => {
      const started = Date.now();
      (function check() {
        const c = page.Calc;
        if (c && typeof c.getState === 'function' && typeof c.setState === 'function') return resolve(c);
        if (Date.now() - started > 60000) return resolve(null);
        setTimeout(check, 300);
      })();
    });
  }

  async function boot() {
    ui.mount();
    try {
      GM_registerMenuCommand('Workspace settings', () => ui.show('settings'));
    } catch (e) { /* menu not supported */ }
    const calc = await waitForCalc();
    if (!calc) {
      setStatus('error', 'Could not find the Desmos calculator on this page.');
      return;
    }
    S.calc = calc;
    calc.observeEvent('change', onCalcChange);
    setInterval(checkPath, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollSoon(0); });
    const { url, key } = settings();
    if (!url || !key) {
      setStatus('setup', 'Add your workspace URL and key to start.');
      ui.show('settings');
      return;
    }
    await autoLink();
    pollSoon(POLL_MS);
  }

  // Link automatically when this page shows a graph the workspace knows.
  async function autoLink() {
    const pending = store.get('pendingOpen', null);
    if (pending && Date.now() - pending.at < 60000) {
      store.set('pendingOpen', null);
      const r = await safeApi('GET', '/graphs/' + pending.id);
      if (r && r.status === 200) return openIntoThisPage(r.data.graph);
    }
    const hash = currentHash();
    if (hash) {
      const r = await safeApi('GET', '/graphs/by-hash/' + encodeURIComponent(hash));
      if (r && r.status === 200) return attach(r.data.graph, true);
    }
    ui.render();
  }

  function setLink(row, base) {
    S.link = {
      id: row.id,
      name: row.name,
      hash: row.desmos_hash,
      calculator: row.calculator,
      version: row.version,
      base,
      updatedBy: row.updated_by,
      note: row.note,
      updatedAt: row.updated_at,
    };
    S.paused = false;
  }

  // Start syncing this page with a workspace graph.
  // reconcile = true when the page might hold a different copy than the workspace.
  function attach(row, reconcile) {
    const local = S.calc.getState();
    if (!reconcile || core.equal(local, row.state)) {
      setLink(row, local);
      saveSyncRecord(row.id, row.version, local);
      ui.render();
      return;
    }
    const rec = syncRecord(row.id);
    setLink(row, row.state);
    if (rec && core.equal(local, rec.state)) {
      // Only the workspace changed since this browser last synced (Claude edited while you were away).
      applyRemote(row, row.state);
      return;
    }
    ui.ask(
      'This desmos.com copy is different from the workspace copy. Which one should both of us use?',
      [
        { label: 'Load workspace copy', run: () => applyRemote(row, row.state) },
        { label: 'Keep this page', run: () => schedulePush(0) },
      ]
    );
    ui.render();
  }

  // Load a workspace graph (usually one Claude started) into the calculator on this page.
  function openIntoThisPage(row) {
    setLink(row, {});
    applyRemote(row, row.state);
  }

  // ------------------------------------------------------------- your edits
  function onCalcChange(_name, event) {
    log('change', { user: event && event.isUserInitiated, applying: S.applying, linked: !!S.link });
    if (S.applying || !S.link || S.paused) return;
    if (event && event.isUserInitiated === false) return; // slider animations, our own setState
    schedulePush(PUSH_DELAY_MS);
  }

  function schedulePush(ms) {
    clearTimeout(S.pushTimer);
    S.pushTimer = setTimeout(push, ms);
  }

  async function push() {
    if (!S.link || S.paused || ui.asking()) return;
    if (S.pushing) { S.pushAgain = true; return; }
    if (location.pathname !== S.lastPath) return; // you are switching graphs; checkPath() handles it
    const state = S.calc.getState();
    if (core.equal(state, S.link.base)) { log('push skipped: no change'); return; }
    S.pushing = true;
    log('push', { base_version: S.link.version });
    try {
      const name = core.titleFromDocument(document.title);
      const r = await safeApi('PUT', '/graphs/' + S.link.id, {
        state,
        base_version: S.link.version,
        name: name || undefined,
      });
      if (!r) { schedulePush(RETRY_MS); return; }
      log('push result', r.status);
      if (r.status === 200) {
        Object.assign(S.link, {
          version: r.data.graph.version,
          base: state,
          updatedBy: 'nathan',
          note: 'Edited on desmos.com',
          updatedAt: r.data.graph.updated_at,
        });
        if (name) S.link.name = name;
        saveSyncRecord(S.link.id, S.link.version, state);
        setStatus('ok');
      } else if (r.status === 409) {
        // Someone else saved first: merge, then push again.
        if (!handleRemote(r.data.graph)) {
          S.link.version = r.data.graph.version;
          schedulePush(0);
        }
      } else if (r.status === 404) {
        detach('This graph is no longer in the workspace.');
      } else {
        setStatus('error', 'Saving to the workspace failed (' + r.status + ').');
        schedulePush(RETRY_MS);
      }
    } finally {
      S.pushing = false;
      if (S.pushAgain) { S.pushAgain = false; schedulePush(0); }
    }
  }

  // ---------------------------------------------------------- Claude's edits
  function pollSoon(ms) {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    try {
      if (S.link && !S.paused && !S.pushing && !ui.asking() && settings().url) {
        const r = await safeApi('GET', '/graphs/' + S.link.id + '?since=' + S.link.version);
        if (r && r.status === 200) handleRemote(r.data.graph);
        else if (r && r.status === 404) detach('This graph is no longer in the workspace.');
      }
    } finally {
      pollSoon(!S.online ? RETRY_MS : document.hidden ? POLL_HIDDEN_MS : POLL_MS);
    }
  }

  function handleRemote(row) {
    log('remote', { version: row.version, by: row.updated_by, have: S.link && S.link.version });
    if (!S.link || row.id !== S.link.id || row.version <= S.link.version) return false;
    const local = S.calc.getState();
    if (core.equal(local, S.link.base)) {
      applyRemote(row, row.state);
      return true;
    }
    // You have edits the workspace hasn't seen yet: merge line by line.
    const merged = core.mergeStates(S.link.base, local, row.state);
    applyRemote(row, merged.state, merged.conflicts, true);
    return true;
  }

  // Put a workspace state into the calculator.
  // needsPush: the applied state is a merge that the workspace doesn't have yet.
  function applyRemote(row, state, conflicts, needsPush) {
    conflicts = conflicts || [];
    const before = S.calc.getState();
    const view = before.graph && before.graph.viewport;
    const baseView = S.link.base && S.link.base.graph && S.link.base.graph.viewport;
    const remoteMovedView = !core.equal(row.state.graph && row.state.graph.viewport, baseView);

    S.applying = true;
    try {
      S.calc.setState(state, { allowUndo: true });
      if (view && !remoteMovedView && typeof S.calc.setMathBounds === 'function') {
        S.calc.setMathBounds({ left: view.xmin, right: view.xmax, bottom: view.ymin, top: view.ymax });
      }
    } catch (err) {
      setTimeout(() => { S.applying = false; }, 50);
      log('apply failed', String(err));
      const message = String((err && err.message) || err).slice(0, 300);
      safeApi('POST', '/graphs/' + row.id + '/status', { status: 'rejected v' + row.version + ': ' + message });
      // Treat that version as seen, so your next edit replaces it instead of retrying forever.
      Object.assign(S.link, { version: row.version, base: row.state });
      ui.toast('A workspace change (version ' + row.version + ') would not load, so your graph was left as it was.', 'error');
      ui.render();
      return;
    }
    setTimeout(() => { S.applying = false; }, 50);
    log('applied', { version: row.version, merged: !!needsPush, conflicts });

    Object.assign(S.link, {
      version: row.version,
      name: row.name || S.link.name,
      updatedBy: row.updated_by,
      note: row.note,
      updatedAt: row.updated_at,
    });
    if (needsPush) {
      S.link.base = row.state;
      schedulePush(300);
    } else {
      S.link.base = S.calc.getState();
      saveSyncRecord(row.id, row.version, S.link.base);
    }
    if (row.updated_by === 'claude') {
      safeApi('POST', '/graphs/' + row.id + '/status', { status: 'applied v' + row.version });
    }

    const who = row.updated_by === 'claude' ? 'Claude' : 'Workspace';
    let text = who + ': ' + (row.note ? row.note.replace(/^Claude:\s*/i, '') : core.describeChange(before, state));
    if (conflicts.length) {
      text += ' (you both changed ' + conflicts.length + ' of the same item' + (conflicts.length > 1 ? 's' : '') +
        "; Claude's version was kept)";
    }
    ui.toast(text, 'info', [{ label: 'Undo', run: () => { try { S.calc.undo(); } catch (e) { /* nothing to undo */ } } }]);
    ui.render();
  }

  function detach(message) {
    S.link = null;
    clearTimeout(S.pushTimer);
    ui.dismissAsk();
    if (message) ui.toast(message, 'info');
    ui.render();
  }

  // Desmos changes the address without reloading when you save or open graphs.
  async function checkPath() {
    if (location.pathname === S.lastPath) return;
    const prev = core.parseDesmosPath(S.lastPath) || {};
    const now = core.parseDesmosPath(location.pathname) || {};
    S.lastPath = location.pathname;
    if (S.link && !prev.hash && now.hash) {
      // First save of a linked graph to your Desmos account: remember its address.
      S.link.hash = now.hash;
      await safeApi('PATCH', '/graphs/' + S.link.id, {
        desmos_hash: now.hash,
        name: core.titleFromDocument(document.title) || undefined,
      });
      ui.render();
      return;
    }
    if (S.link) detach();
    if (now.hash) {
      const r = await safeApi('GET', '/graphs/by-hash/' + encodeURIComponent(now.hash));
      if (r && r.status === 200) attach(r.data.graph, true);
    }
    ui.render();
  }

  // ---------------------------------------------------------------- actions
  const actions = {
    async link() {
      const here = core.parseDesmosPath(location.pathname) || { calculator: 'graphing', hash: null };
      const state = S.calc.getState();
      const r = await safeApi('POST', '/graphs', {
        name: core.titleFromDocument(document.title) || 'Untitled graph',
        calculator: here.calculator,
        desmos_hash: here.hash,
        state,
      });
      if (!r) return;
      if (r.status === 201) {
        attach(r.data.graph, false);
        ui.toast('Linked. Claude can now see and edit this graph.', 'info');
      } else if (r.status === 200 && r.data.existing) {
        attach(r.data.graph, true);
      } else {
        ui.toast('Could not link this graph (' + r.status + ': ' + ((r.data && r.data.error) || 'error') + ').', 'error');
      }
    },
    pause() {
      S.paused = true;
      clearTimeout(S.pushTimer);
      ui.render();
    },
    async resume() {
      if (!S.link) return;
      const r = await safeApi('GET', '/graphs/' + S.link.id);
      if (r && r.status === 200) attach(r.data.graph, true);
    },
    async listGraphs() {
      const r = await safeApi('GET', '/graphs');
      return r && r.status === 200 ? r.data.graphs : null;
    },
    open(row) {
      if (S.link && row.id === S.link.id) return;
      if (row.desmos_hash) {
        location.assign(core.desmosPathFor(row.calculator, row.desmos_hash));
      } else {
        store.set('pendingOpen', { id: row.id, at: Date.now() });
        location.assign(core.desmosPathFor(row.calculator, null));
      }
    },
    async versions() {
      if (!S.link) return null;
      const r = await safeApi('GET', '/graphs/' + S.link.id + '/versions');
      return r && r.status === 200 ? r.data.versions : null;
    },
    async restore(version) {
      if (!S.link) return;
      const r = await safeApi('POST', '/graphs/' + S.link.id + '/restore', { version });
      if (r && r.status === 200) handleRemote(r.data.graph);
      else ui.toast('Restore failed.', 'error');
    },
    async saveSettings(url, key) {
      store.set('apiUrl', url.trim());
      store.set('apiKey', key.trim());
      const r = await safeApi('GET', '/graphs');
      if (!r || r.status !== 200) {
        ui.toast('Could not reach the workspace with those settings.', 'error');
        return false;
      }
      setStatus('ok');
      ui.toast('Connected to the workspace.', 'info');
      if (S.calc && !S.link) await autoLink();
      pollSoon(POLL_MS);
      return true;
    },
  };

  // --------------------------------------------------------------------- ui
  const ui = (() => {
    let root = null;
    let open = store.get('panelOpen', true);
    let view = 'main';
    let statusKind = 'idle';
    let statusText = '';
    let pendingAsk = null;
    let toasts = [];
    let listData = null;

    const css = `
      :host { all: initial; }
      .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #1f2328; }
      .pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;
        background: #fff; border: 1px solid #c9ced6; box-shadow: 0 1px 4px rgba(0,0,0,.12); cursor: pointer; }
      .panel { width: 300px; background: #fff; border: 1px solid #c9ced6; border-radius: 10px;
        box-shadow: 0 4px 16px rgba(0,0,0,.14); overflow: hidden; }
      .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eaecef; }
      .head b { flex: 1; font-size: 13px; }
      .body { padding: 10px 12px; display: grid; gap: 8px; max-height: 360px; overflow: auto; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa1ab; flex: none; }
      .dot.ok { background: #2e9e5b; } .dot.offline, .dot.setup { background: #d29a1e; } .dot.error { background: #c74440; }
      .muted { color: #59636e; font-size: 12px; }
      .name { font-weight: 600; overflow-wrap: anywhere; }
      .row { display: flex; gap: 6px; flex-wrap: wrap; }
      button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid #c9ced6;
        background: #f6f8fa; color: #1f2328; cursor: pointer; }
      button:hover { background: #eef1f4; }
      button.primary { background: #2d70b3; border-color: #2d70b3; color: #fff; }
      button.primary:hover { background: #255f99; }
      button.x { border: none; background: none; padding: 2px 6px; font-size: 14px; color: #59636e; }
      .item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid #eaecef; }
      .item:first-child { border-top: none; }
      .item .grow { flex: 1; min-width: 0; }
      .toast { padding: 8px 10px; border-radius: 6px; background: #eef4fb; border: 1px solid #c5d8ee; display: grid; gap: 6px; }
      .toast.error { background: #fbeeee; border-color: #eec5c5; }
      .ask { padding: 8px 10px; border-radius: 6px; background: #fff8e6; border: 1px solid #f0d9a0; display: grid; gap: 6px; }
      label { display: grid; gap: 4px; font-size: 12px; color: #59636e; }
      input { font: inherit; padding: 6px 8px; border: 1px solid #c9ced6; border-radius: 6px; width: 100%; box-sizing: border-box; }
    `;

    function mount() {
      const host = document.createElement('div');
      host.id = 'desmos-workspace-bridge';
      document.documentElement.appendChild(host);
      root = host.attachShadow({ mode: 'open' });
      render();
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function el(html) {
      const t = document.createElement('template');
      t.innerHTML = html.trim();
      return t.content.firstElementChild;
    }

    function on(node, selector, handler) {
      node.querySelectorAll(selector).forEach((n) => n.addEventListener('click', handler));
    }

    function dotClass() {
      if (statusKind === 'ok' && !S.link) return 'idle';
      return statusKind;
    }

    function summary() {
      if (statusKind === 'setup') return 'Setup needed';
      if (statusKind === 'offline') return 'Offline';
      if (statusKind === 'error') return 'Problem';
      if (!S.link) return 'Not linked';
      if (S.paused) return 'Paused';
      return 'Synced';
    }

    function render() {
      if (!root) return;
      root.innerHTML = '';
      const style = document.createElement('style');
      style.textContent = css;
      root.appendChild(style);
      const wrap = el('<div class="wrap"></div>');
      root.appendChild(wrap);

      if (!open) {
        const pill = el(`<div class="pill" title="Desmos workspace"><span class="dot ${dotClass()}"></span>Workspace · ${esc(summary())}</div>`);
        pill.addEventListener('click', () => { open = true; store.set('panelOpen', true); render(); });
        wrap.appendChild(pill);
        return;
      }

      const panel = el(`<div class="panel">
        <div class="head"><span class="dot ${dotClass()}"></span><b>Workspace · ${esc(summary())}</b>
          <button class="x" data-a="close" title="Minimize">–</button></div>
        <div class="body"></div></div>`);
      wrap.appendChild(panel);
      on(panel, '[data-a=close]', () => { open = false; store.set('panelOpen', false); render(); });
      const body = panel.querySelector('.body');

      toasts.forEach((t) => {
        const node = el(`<div class="toast ${t.kind === 'error' ? 'error' : ''}"><div>${esc(t.text)}</div><div class="row"></div></div>`);
        const row = node.querySelector('.row');
        (t.buttons || []).forEach((b) => {
          const btn = el(`<button>${esc(b.label)}</button>`);
          btn.addEventListener('click', () => { removeToast(t); b.run(); });
          row.appendChild(btn);
        });
        const dismiss = el('<button>Dismiss</button>');
        dismiss.addEventListener('click', () => removeToast(t));
        row.appendChild(dismiss);
        body.appendChild(node);
      });

      if (pendingAsk) {
        const node = el(`<div class="ask"><div>${esc(pendingAsk.text)}</div><div class="row"></div></div>`);
        const row = node.querySelector('.row');
        pendingAsk.options.forEach((o, i) => {
          const btn = el(`<button class="${i === 0 ? 'primary' : ''}">${esc(o.label)}</button>`);
          btn.addEventListener('click', () => { const run = o.run; pendingAsk = null; render(); run(); });
          row.appendChild(btn);
        });
        body.appendChild(node);
      }

      if (statusText && statusKind !== 'ok') body.appendChild(el(`<div class="muted">${esc(statusText)}</div>`));

      if (view === 'settings') return renderSettings(body);
      if (view === 'graphs') return renderGraphs(body);
      if (view === 'history') return renderHistory(body);
      renderMain(body);
    }

    function renderMain(body) {
      if (!S.calc) {
        body.appendChild(el('<div class="muted">Waiting for the calculator…</div>'));
      } else if (S.link) {
        const who = S.link.updatedBy === 'claude' ? 'Claude' : 'You';
        body.appendChild(el(`<div><div class="name">${esc(S.link.name)}</div>
          <div class="muted">Version ${esc(S.link.version)} · last change by ${who}${S.link.updatedAt ? ', ' + esc(core.timeAgo(S.link.updatedAt)) : ''}</div>
          ${S.link.note ? `<div class="muted">${esc(S.link.note)}</div>` : ''}</div>`));
        if (!S.link.hash) {
          body.appendChild(el('<div class="muted">Not saved to your Desmos account yet. Press Ctrl+S (or Save) to keep a copy there too.</div>'));
        }
      } else {
        body.appendChild(el('<div class="muted">This graph is not shared with the workspace. Link it so Claude can see and edit it.</div>'));
      }
      const row = el('<div class="row"></div>');
      if (S.calc && !S.link) row.appendChild(button('Link this graph', actions.link, true));
      if (S.link && !S.paused) row.appendChild(button('Pause sync', actions.pause));
      if (S.link && S.paused) row.appendChild(button('Resume sync', actions.resume, true));
      row.appendChild(button('Graphs', () => show('graphs')));
      if (S.link) row.appendChild(button('History', () => show('history')));
      row.appendChild(button('Settings', () => show('settings')));
      body.appendChild(row);
    }

    function renderSettings(body) {
      const s = settings();
      const form = el(`<div style="display:grid;gap:8px">
        <label>Workspace URL<input data-f="url" placeholder="https://….supabase.co/functions/v1/desmos-bridge" value="${esc(s.url)}"></label>
        <label>Workspace key<input data-f="key" type="password" value="${esc(s.key)}"></label>
        <div class="row"><button class="primary" data-a="save">Save</button><button data-a="back">Back</button></div></div>`);
      on(form, '[data-a=save]', async () => {
        const ok = await actions.saveSettings(form.querySelector('[data-f=url]').value, form.querySelector('[data-f=key]').value);
        if (ok) show('main');
      });
      on(form, '[data-a=back]', () => show('main'));
      body.appendChild(form);
    }

    function renderGraphs(body) {
      body.appendChild(el('<div class="name">Workspace graphs</div>'));
      if (listData === null) {
        body.appendChild(el('<div class="muted">Loading…</div>'));
      } else if (!listData.length) {
        body.appendChild(el('<div class="muted">No graphs yet.</div>'));
      } else {
        const list = el('<div></div>');
        listData.forEach((g) => {
          const isHere = S.link && S.link.id === g.id;
          const item = el(`<div class="item"><div class="grow"><div class="name">${esc(g.name)}</div>
            <div class="muted">${g.updated_by === 'claude' ? 'Claude' : 'You'}, ${esc(core.timeAgo(g.updated_at))}${g.calculator !== 'graphing' ? ' · ' + esc(g.calculator) : ''}</div></div></div>`);
          item.appendChild(isHere ? el('<span class="muted">Open</span>') : button('Open', () => actions.open(g)));
          list.appendChild(item);
        });
        body.appendChild(list);
      }
      body.appendChild(el('<div class="row"></div>')).appendChild(button('Back', () => show('main')));
    }

    function renderHistory(body) {
      body.appendChild(el('<div class="name">History</div>'));
      if (listData === null) {
        body.appendChild(el('<div class="muted">Loading…</div>'));
      } else {
        const list = el('<div></div>');
        listData.forEach((v) => {
          const item = el(`<div class="item"><div class="grow"><div>Version ${esc(v.version)} · ${v.updated_by === 'claude' ? 'Claude' : 'You'}, ${esc(core.timeAgo(v.created_at))}</div>
            ${v.note ? `<div class="muted">${esc(v.note)}</div>` : ''}</div></div>`);
          if (S.link && v.version !== S.link.version) item.appendChild(button('Restore', () => { actions.restore(v.version); show('main'); }));
          else item.appendChild(el('<span class="muted">Current</span>'));
          list.appendChild(item);
        });
        body.appendChild(list);
      }
      body.appendChild(el('<div class="row"></div>')).appendChild(button('Back', () => show('main')));
    }

    function button(label, run, primary) {
      const b = el(`<button class="${primary ? 'primary' : ''}">${esc(label)}</button>`);
      b.addEventListener('click', run);
      return b;
    }

    async function show(next) {
      view = next;
      open = true;
      listData = null;
      render();
      if (next === 'graphs') { listData = (await actions.listGraphs()) || []; render(); }
      if (next === 'history') { listData = (await actions.versions()) || []; render(); }
    }

    function removeToast(t) {
      toasts = toasts.filter((x) => x !== t);
      render();
    }

    function toast(text, kind, buttons) {
      const t = { text, kind, buttons };
      toasts = [t].concat(toasts).slice(0, 3);
      if (kind !== 'error') setTimeout(() => { if (toasts.includes(t)) removeToast(t); }, 20000);
      render();
    }

    return {
      mount,
      render,
      show,
      toast,
      status(kind, text) { statusKind = kind; statusText = text || ''; render(); },
      ask(text, options) { pendingAsk = { text, options }; open = true; render(); },
      asking: () => !!pendingAsk,
      dismissAsk() { pendingAsk = null; },
    };
  })();

  // Exposed for debugging from the console: DesmosWorkspaceBridge.state()
  page.DesmosWorkspaceBridge = {
    state: () => ({ link: S.link && { ...S.link, base: undefined }, paused: S.paused, online: S.online }),
    log: () => events.slice(),
  };

  boot();
})();
