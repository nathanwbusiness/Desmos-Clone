// Pure helpers shared by the userscript and the tests. No DOM, no network.
/* eslint-disable no-var */
var BridgeCore = (function () {
  'use strict';

  // JSON with sorted keys, so two states compare equal whatever their key order
  // (Postgres jsonb reorders keys; Desmos doesn't care about order).
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      return (
        '{' +
        Object.keys(value)
          .filter(function (k) { return value[k] !== undefined; })
          .sort()
          .map(function (k) { return JSON.stringify(k) + ':' + canonical(value[k]); })
          .join(',') +
        '}'
      );
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  function equal(a, b) {
    return canonical(a) === canonical(b);
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function list(state) {
    return (state && state.expressions && state.expressions.list) || [];
  }

  function byId(items) {
    var map = Object.create(null);
    items.forEach(function (item) { if (item && item.id != null) map[String(item.id)] = item; });
    return map;
  }

  // Three-way merge of one value. Returns { value, conflict }.
  // On a real conflict the incoming ("theirs") value wins: it is the later write.
  function merge3(base, mine, theirs) {
    if (equal(mine, theirs)) return { value: mine, conflict: false };
    if (equal(mine, base)) return { value: theirs, conflict: false };
    if (equal(theirs, base)) return { value: mine, conflict: false };
    return { value: theirs, conflict: true };
  }

  // Merge two edits of the same graph made from a common base state.
  //   base   = last state both sides agreed on
  //   mine   = the state in the open desmos.com tab
  //   theirs = the newer state from the workspace
  // Expressions are merged one by one (by id), so a change to one line never
  // overwrites a change to another. The viewport always follows "mine", so the
  // graph doesn't jump while you are looking at it.
  // Returns { state, conflicts: [expression ids or setting names] }.
  function mergeStates(base, mine, theirs) {
    base = base || {};
    if (equal(mine, base)) return { state: clone(theirs), conflicts: [] };
    if (equal(theirs, base)) return { state: clone(mine), conflicts: [] };

    var conflicts = [];
    var out = {};
    var keys = unionKeys([base, mine, theirs]);

    keys.forEach(function (key) {
      if (key === 'expressions') return;
      if (key === 'graph') {
        out.graph = mergeGraphSettings(base.graph, mine.graph, theirs.graph, conflicts);
        return;
      }
      var r = merge3(base[key], mine[key], theirs[key]);
      if (r.conflict) conflicts.push(key);
      if (r.value !== undefined) out[key] = clone(r.value);
    });

    var be = base.expressions || {}, me = mine.expressions || {}, te = theirs.expressions || {};
    var exprs = {};
    unionKeys([be, me, te]).forEach(function (key) {
      if (key === 'list') return;
      var r = merge3(be[key], me[key], te[key]);
      if (r.conflict) conflicts.push('expressions.' + key);
      if (r.value !== undefined) exprs[key] = clone(r.value);
    });
    exprs.list = mergeLists(list(base), list(mine), list(theirs), conflicts);
    out.expressions = exprs;

    return { state: out, conflicts: conflicts };
  }

  function mergeGraphSettings(base, mine, theirs, conflicts) {
    base = base || {};
    mine = mine || {};
    theirs = theirs || {};
    var out = {};
    unionKeys([base, mine, theirs]).forEach(function (key) {
      if (key === 'viewport') {
        if (mine.viewport !== undefined) out.viewport = clone(mine.viewport);
        else if (theirs.viewport !== undefined) out.viewport = clone(theirs.viewport);
        return;
      }
      var r = merge3(base[key], mine[key], theirs[key]);
      if (r.conflict) conflicts.push('graph.' + key);
      if (r.value !== undefined) out[key] = clone(r.value);
    });
    return out;
  }

  function mergeLists(baseList, mineList, theirsList, conflicts) {
    var b = byId(baseList), m = byId(mineList), t = byId(theirsList);
    var keep = Object.create(null);

    unionIds([baseList, mineList, theirsList]).forEach(function (id) {
      var inB = id in b, inM = id in m, inT = id in t;
      if (!inB) {
        if (inM && inT) {
          var r = merge3(undefined, m[id], t[id]);
          if (r.conflict) conflicts.push(id);
          keep[id] = r.value;
        } else {
          keep[id] = inM ? m[id] : t[id];
        }
        return;
      }
      if (!inM && !inT) return; // both removed it
      if (!inM) {
        // You removed it. Keep it only if the workspace changed it meanwhile.
        if (equal(t[id], b[id])) return;
        conflicts.push(id);
        keep[id] = t[id];
        return;
      }
      if (!inT) {
        // The workspace removed it. Keep it only if you changed it meanwhile.
        if (equal(m[id], b[id])) return;
        conflicts.push(id);
        keep[id] = m[id];
        return;
      }
      var r2 = merge3(b[id], m[id], t[id]);
      if (r2.conflict) conflicts.push(id);
      keep[id] = r2.value;
    });

    // Order: the workspace's order, then anything only you have, placed right
    // after the item it followed in your tab.
    var order = [];
    theirsList.forEach(function (e) { var id = String(e.id); if (id in keep) order.push(id); });
    var placed = Object.create(null);
    order.forEach(function (id) { placed[id] = true; });
    var prev = null;
    mineList.forEach(function (e) {
      var id = String(e.id);
      if (!(id in keep)) return;
      if (!placed[id]) {
        var at = prev === null ? 0 : order.indexOf(prev) + 1;
        order.splice(at, 0, id);
        placed[id] = true;
      }
      prev = id;
    });
    Object.keys(keep).forEach(function (id) { if (!placed[id]) order.push(id); });

    return order.map(function (id) { return clone(keep[id]); });
  }

  function unionKeys(objects) {
    var seen = Object.create(null), out = [];
    objects.forEach(function (o) {
      Object.keys(o || {}).forEach(function (k) { if (!seen[k]) { seen[k] = true; out.push(k); } });
    });
    return out;
  }

  function unionIds(lists) {
    var seen = Object.create(null), out = [];
    lists.forEach(function (l) {
      l.forEach(function (e) {
        if (!e || e.id == null) return;
        var id = String(e.id);
        if (!seen[id]) { seen[id] = true; out.push(id); }
      });
    });
    return out;
  }

  // Short, human summary of what changed between two states.
  function describeChange(before, after) {
    var b = byId(list(before)), a = byId(list(after));
    var added = 0, removed = 0, changed = 0;
    Object.keys(a).forEach(function (id) {
      if (!(id in b)) added++;
      else if (!equal(a[id], b[id])) changed++;
    });
    Object.keys(b).forEach(function (id) { if (!(id in a)) removed++; });
    var parts = [];
    if (added) parts.push(added + ' added');
    if (changed) parts.push(changed + ' changed');
    if (removed) parts.push(removed + ' removed');
    if (!parts.length) parts.push('settings changed');
    return parts.join(', ');
  }

  // desmos.com/calculator/abc123 -> { calculator: 'graphing', hash: 'abc123' }
  function parseDesmosPath(pathname) {
    var m = /^\/(calculator|3d|geometry)(?:\/([A-Za-z0-9_-]+))?\/?$/.exec(pathname || '');
    if (!m) return null;
    var calculator = m[1] === 'calculator' ? 'graphing' : m[1];
    return { calculator: calculator, hash: m[2] || null };
  }

  function desmosPathFor(calculator, hash) {
    var base = calculator === '3d' ? '/3d' : calculator === 'geometry' ? '/geometry' : '/calculator';
    return hash ? base + '/' + hash : base;
  }

  // "My graph | Desmos" -> "My graph"
  function titleFromDocument(title) {
    var t = String(title || '').replace(/\s*[|–—-]\s*Desmos.*$/i, '').trim();
    if (!t || /^desmos\b/i.test(t) || /^untitled graph$/i.test(t)) return null;
    return t.slice(0, 200);
  }

  function timeAgo(iso, now) {
    var then = Date.parse(iso);
    if (!isFinite(then)) return '';
    var s = Math.max(0, Math.round(((now || Date.now()) - then) / 1000));
    if (s < 45) return 'just now';
    var min = Math.round(s / 60);
    if (min < 60) return min + ' min ago';
    var h = Math.round(min / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  return {
    canonical: canonical,
    equal: equal,
    clone: clone,
    mergeStates: mergeStates,
    describeChange: describeChange,
    parseDesmosPath: parseDesmosPath,
    desmosPathFor: desmosPathFor,
    titleFromDocument: titleFromDocument,
    timeAgo: timeAgo,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BridgeCore;
