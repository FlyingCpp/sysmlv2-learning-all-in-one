'use strict';

// 对 ELK 未避开的文字障碍做有界正交布线；保持原始端口和关系身份。
function routeBetween(start, finish, boxes, deadline) {
  const xs = [...new Set([start.x, finish.x, ...boxes.flatMap(b => [b.x - 8, b.x + b.width + 8])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, finish.y, ...boxes.flatMap(b => [b.y - 8, b.y + b.height + 8])])].sort((a, b) => a - b);
  if (xs.length * ys.length > 250000) throw new Error('ROUTING_GRID_BUDGET');
  const width = xs.length;
  const key = (x, y) => y * width + x;
  const first = key(xs.indexOf(start.x), ys.indexOf(start.y));
  const last = key(xs.indexOf(finish.x), ys.indexOf(finish.y));
  const distance = new Map([[first, 0]]), previous = new Map(), heap = [];
  function push(id, cost) {
    let i = heap.length;
    heap.push({ id, cost });
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].cost <= cost) break;
      heap[i] = heap[p]; i = p;
    }
    heap[i] = { id, cost };
  }
  function pop() {
    const result = heap[0], tail = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child++;
        if (heap[child].cost >= tail.cost) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = tail;
    }
    return result;
  }
  const point = id => ({ x: xs[id % width], y: ys[Math.floor(id / width)] });
  const clear = (a, b) => !boxes.some(box => a.x === b.x
    ? a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height
    : a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width);
  push(first, 0);
  let visited = 0;
  while (heap.length) {
    if ((visited++ & 255) === 0 && Date.now() > deadline) throw new Error('ROUTING_TIME_BUDGET');
    const { id, cost } = pop();
    if (cost !== distance.get(id)) continue;
    if (id === last) {
      const points = [point(id)];
      let cursor = id;
      while (previous.has(cursor)) { cursor = previous.get(cursor); points.unshift(point(cursor)); }
      return points.filter((p, i) => i === 0 || i === points.length - 1
        || !((points[i - 1].x === p.x && p.x === points[i + 1].x) || (points[i - 1].y === p.y && p.y === points[i + 1].y)));
    }
    const x = id % width, y = Math.floor(id / width), a = point(id);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= ys.length) continue;
      const next = key(nx, ny), b = point(next);
      const nextCost = cost + Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (nextCost >= (distance.get(next) ?? Infinity) || !clear(a, b)) continue;
      distance.set(next, nextCost); previous.set(next, id); push(next, nextCost);
    }
  }
  throw new Error('NO_OBSTACLE_FREE_ROUTE');
}

module.exports = { routeBetween };
