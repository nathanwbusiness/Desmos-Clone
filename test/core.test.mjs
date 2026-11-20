import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../bridge/core.cjs');

const expr = (id, latex, extra = {}) => ({ type: 'expression', id, latex, color: '#2d70b3', ...extra });
const state = (list, graph = { viewport: { xmin: -10, ymin: -10, xmax: 10, ymax: 10 } }, extra = {}) => ({
  version: 11,
  randomSeed: 'abc',
  graph,
  expressions: { list },
  ...extra,
});
const ids = (s) => s.expressions.list.map((e) => e.id);

test('canonical ignores key order', () => {
  assert.equal(core.canonical({ b: 1, a: { d: 2, c: 3 } }), core.canonical({ a: { c: 3, d: 2 }, b: 1 }));
  assert.ok(core.equal({ a: [1, { y: 1, x: 2 }] }, { a: [1, { x: 2, y: 1 }] }));
  assert.ok(!core.equal({ a: [1, 2] }, { a: [2, 1] }));
});

test('only the workspace changed: take theirs', () => {
  const base = state([expr('1', 'y=x')]);
  const theirs = state([expr('1', 'y=x'), expr('2', 'y=x^2')]);
  const r = core.mergeStates(base, core.clone(base), theirs);
  assert.deepEqual(r.state, theirs);
  assert.deepEqual(r.conflicts, []);
});

test('only you changed: keep mine', () => {
  const base = state([expr('1', 'y=x')]);
  const mine = state([expr('1', 'y=2x')]);
  const r = core.mergeStates(base, mine, core.clone(base));
  assert.deepEqual(r.state, mine);
});

test('different expressions changed on each side are both kept', () => {
  const base = state([expr('1', 'y=x'), expr('2', 'y=x^2')]);
  const mine = state([expr('1', 'y=3x'), expr('2', 'y=x^2')]);
  const theirs = state([expr('1', 'y=x'), expr('2', 'y=x^2+1')]);
  const r = core.mergeStates(base, mine, theirs);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.state.expressions.list[0].latex, 'y=3x');
  assert.equal(r.state.expressions.list[1].latex, 'y=x^2+1');
});

test('same expression changed on both sides: workspace wins and it is reported', () => {
  const base = state([expr('1', 'y=x')]);
  const mine = state([expr('1', 'y=5x')]);
  const theirs = state([expr('1', 'y=7x')]);
  const r = core.mergeStates(base, mine, theirs);
  assert.deepEqual(r.conflicts, ['1']);
  assert.equal(r.state.expressions.list[0].latex, 'y=7x');
});

test('additions on both sides keep their positions', () => {
  const base = state([expr('1', 'a'), expr('2', 'b')]);
  const mine = state([expr('1', 'a'), expr('m', 'mine'), expr('2', 'b')]);
  const theirs = state([expr('1', 'a'), expr('2', 'b'), expr('t', 'theirs')]);
  const r = core.mergeStates(base, mine, theirs);
  assert.deepEqual(ids(r.state), ['1', 'm', '2', 't']);
  assert.deepEqual(r.conflicts, []);
});

test('my addition at the top stays at the top', () => {
  const base = state([expr('1', 'a')]);
  const mine = state([expr('m', 'mine'), expr('1', 'a')]);
  const theirs = state([expr('1', 'a2')]);
  const r = core.mergeStates(base, mine, theirs);
  assert.deepEqual(ids(r.state), ['m', '1']);
  assert.equal(r.state.expressions.list[1].latex, 'a2');
});

test('removals: clean removal applies, removal of an edited line keeps the edit', () => {
  const base = state([expr('1', 'a'), expr('2', 'b'), expr('3', 'c')]);
  const mine = state([expr('2', 'b'), expr('3', 'c-edited')]); // I removed 1, edited 3
  const theirs = state([expr('1', 'a'), expr('2', 'b')]); // workspace removed 3
  const r = core.mergeStates(base, mine, theirs);
  assert.deepEqual(ids(r.state), ['2', '3']);
  assert.equal(r.state.expressions.list[1].latex, 'c-edited');
  assert.deepEqual(r.conflicts, ['3']);
});

test('viewport always follows the open tab; other settings merge', () => {
  const base = state([expr('1', 'a')], { viewport: { xmin: -10, xmax: 10, ymin: -10, ymax: 10 }, degreeMode: false });
  const mine = state([expr('1', 'b')], { viewport: { xmin: -2, xmax: 2, ymin: -2, ymax: 2 }, degreeMode: false });
  const theirs = state([expr('1', 'a')], { viewport: { xmin: -50, xmax: 50, ymin: -50, ymax: 50 }, degreeMode: true });
  const r = core.mergeStates(base, mine, theirs);
  assert.deepEqual(r.state.graph.viewport, { xmin: -2, xmax: 2, ymin: -2, ymax: 2 });
  assert.equal(r.state.graph.degreeMode, true);
  assert.equal(r.state.expressions.list[0].latex, 'b');
});

test('ticker and other expression-level keys merge', () => {
  const base = state([expr('1', 'a')]);
  base.expressions.ticker = { handlerLatex: 'a->a+1', open: false };
  const mine = core.clone(base);
  mine.expressions.list[0].latex = 'b';
  const theirs = core.clone(base);
  theirs.expressions.ticker = { handlerLatex: 'a->a+2', open: true };
  const r = core.mergeStates(base, mine, theirs);
  assert.deepEqual(r.state.expressions.ticker, { handlerLatex: 'a->a+2', open: true });
  assert.equal(r.state.expressions.list[0].latex, 'b');
});

test('merge does not mutate its inputs', () => {
  const base = state([expr('1', 'a')]);
  const mine = state([expr('1', 'b')]);
  const theirs = state([expr('1', 'a'), expr('2', 'c')]);
  const snapshot = JSON.stringify([base, mine, theirs]);
  const r = core.mergeStates(base, mine, theirs);
  r.state.expressions.list[0].latex = 'changed';
  assert.equal(JSON.stringify([base, mine, theirs]), snapshot);
});

test('describeChange counts expression changes', () => {
  const a = state([expr('1', 'a'), expr('2', 'b')]);
  const b = state([expr('1', 'a2'), expr('3', 'c')]);
  assert.equal(core.describeChange(a, b), '1 added, 1 changed, 1 removed');
  assert.equal(core.describeChange(a, a), 'settings changed');
});

test('desmos paths', () => {
  assert.deepEqual(core.parseDesmosPath('/calculator/abc123XY'), { calculator: 'graphing', hash: 'abc123XY' });
  assert.deepEqual(core.parseDesmosPath('/calculator'), { calculator: 'graphing', hash: null });
  assert.deepEqual(core.parseDesmosPath('/3d/q1w2e3'), { calculator: '3d', hash: 'q1w2e3' });
  assert.equal(core.parseDesmosPath('/api/v1.12/docs'), null);
  assert.equal(core.desmosPathFor('graphing', 'x'), '/calculator/x');
  assert.equal(core.desmosPathFor('3d', null), '/3d');
});

test('titles from the browser tab', () => {
  assert.equal(core.titleFromDocument('Projectile motion | Desmos'), 'Projectile motion');
  assert.equal(core.titleFromDocument('Desmos | Graphing Calculator'), null);
  assert.equal(core.titleFromDocument('Untitled Graph | Desmos'), null);
});
