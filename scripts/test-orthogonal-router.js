'use strict';

const assert = require('node:assert/strict');
const { routeBetween } = require('../packages/sysml-plantuml-service/orthogonal-router');
const { segmentHitsBox, createGraph } = require('../packages/sysml-plantuml-service/diagram-layout');

const obstacle = { x: 40, y: -10, width: 20, height: 20 };
const start = { x: 0, y: 0 }, finish = { x: 100, y: 0 };
const route = routeBetween(start, finish, [obstacle], Date.now() + 1000);
assert.deepEqual(route[0], start);
assert.deepEqual(route.at(-1), finish);
for (let i = 1; i < route.length; i++) {
  assert(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y);
  assert.equal(segmentHitsBox(route[i - 1], route[i], obstacle), false);
}
assert.throws(() => routeBetween(start, finish, [obstacle], 0), /ROUTING_TIME_BUDGET/);
assert.throws(() => routeBetween(start, finish,
  Array.from({ length: 300 }, (_, i) => ({ x: i * 31, y: i * 37, width: 9, height: 11 })), Date.now() + 1000), /ROUTING_GRID_BUDGET/);
assert.throws(() => routeBetween(start, finish, [{ x: -10, y: -10, width: 20, height: 20 }], Date.now() + 1000), /NO_OBSTACLE_FREE_ROUTE/);
console.log('orthogonal router PASS: exact endpoints, obstacle avoidance, time/grid budgets and blocked route');

// 输入预算验收；不把图构造成功当作这些规模的布局性能保证。
const document = { profile: 'port-network', nodes: [{ id: 'n0', parentId: '', labelLines: [] }],
  ports: [{ id: 'p0', ownerId: 'n0' }, { id: 'p1', ownerId: 'n0' }], edges: [] };
for (const count of [199, 200, 201]) {
  const candidate = { ...document, nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, parentId: '' })) };
  if (count <= 200) assert.doesNotThrow(() => createGraph(candidate));
  else assert.throws(() => createGraph(candidate), /图形数量/);
}
for (const [field, limit, item] of [
  ['ports', 1200, i => ({ id: `p${i}`, ownerId: 'n0' })],
  ['edges', 800, i => ({ id: `e${i}`, source: 'p0', target: 'p1' })]
]) for (const count of [limit - 1, limit, limit + 1]) {
  const candidate = { ...document, [field]: Array.from({ length: count }, (_, i) => item(i)) };
  if (count <= limit) assert.doesNotThrow(() => createGraph(candidate));
  else assert.throws(() => createGraph(candidate), /图形数量/);
}
console.log('layout input budgets PASS: nodes 199/200/201, ports 1199/1200/1201, edges 799/800/801');
