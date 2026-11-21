// What the figure says about one particle's tree walk, decided from the
// numbers the module reports. DOM-free, so the smoke test checks each claim
// the figure prints, and the worker and the page share it.

import { VIEW_RADIUS } from "./settings.js";

// Numbers per cell in the arrays of treeCells and walkTrace: centre x, y and
// z, edge length and depth.
export const NUMBERS_PER_CELL = 5;

// Where the default marked particle is looked for, in units of the view
// radius.
const DEFAULT_MARK_AIM = [0.5, -0.25];

const squaredDistance = (a, b) => a.reduce((sum, value, axis) => sum + (value - b[axis]) ** 2, 0);

// The opening test of the accepted cell with the largest edge, ties to the
// nearest, as the code applies it: a cell is accepted when d * theta >
// s + theta * delta, which is s / (d - delta) < theta. s is the edge, d the
// distance from the particle to the cell's centre of mass and delta the
// offset of that centre from the cell's centre. Null when no cell was
// accepted.
export function openingTest(accepted, centresOfMass, position, theta) {
  let best = null;
  for (let cell = 0; cell < accepted.length / NUMBERS_PER_CELL; cell++) {
    const edge = accepted[NUMBERS_PER_CELL * cell + 3];
    const distance = Math.sqrt(squaredDistance(position, centresOfMass.subarray(3 * cell, 3 * cell + 3)));
    if (!best || edge > best.edge || (edge === best.edge && distance < best.distance)) {
      best = { cell, edge, distance };
    }
  }
  if (!best) {
    return null;
  }
  const first = NUMBERS_PER_CELL * best.cell;
  const centre = accepted.subarray(first, first + 3);
  const offset = Math.sqrt(squaredDistance(centresOfMass.subarray(3 * best.cell, 3 * best.cell + 3), centre));
  return { ...best, offset, ratio: best.edge / (best.distance - offset), theta };
}

// The cells and the single particles one particle's force is summed from,
// counted once however the cells overlap on screen. Null when there is
// nothing to count: no tree walk yet, or a setup with no tree.
export function walkCounts(probe, count, setup, method) {
  if (setup === "kepler") {
    return null;
  }
  if (method === "direct") {
    return { cells: 0, particles: count - 1 };
  }
  if (!probe) {
    return null;
  }
  const cells = probe.accepted.length / NUMBERS_PER_CELL;
  return { cells, particles: probe.interactions - cells };
}

// The particle nearest the default aim point, or -1 for a setup with no mark
// or when there are no positions. positions holds x and y per particle.
export function defaultMarkedParticle(positions, setup) {
  if (setup === "kepler" || !positions) {
    return -1;
  }
  const aim = DEFAULT_MARK_AIM.map((fraction) => fraction * VIEW_RADIUS[setup]);
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < positions.length / 2; i++) {
    const distance = (positions[2 * i] - aim[0]) ** 2 + (positions[2 * i + 1] - aim[1]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

// One flag per opened cell: 1 when none of its children was visited, so the
// walk went on to single particles there. The cells sit on the grid of the
// first opened cell, the root, which gives each cell's parent by index.
export function openedLeaves(opened, accepted) {
  const count = opened.length / NUMBERS_PER_CELL;
  const leaves = new Uint8Array(count).fill(1);
  if (count === 0) {
    return leaves;
  }
  const rootEdge = opened[3];
  const origin = [0, 1, 2].map((axis) => opened[axis] - rootEdge / 2);
  const keyOf = (cells, first, parent) => {
    const depth = cells[first + 4];
    const edge = rootEdge / 2 ** depth;
    const indices = origin.map((start, axis) => Math.floor((cells[first + axis] - start) / edge));
    return parent ? `${depth - 1}/${indices.map((index) => index >> 1)}` : `${depth}/${indices}`;
  };
  const parents = new Set();
  for (const cells of [opened, accepted]) {
    for (let first = 0; first < cells.length; first += NUMBERS_PER_CELL) {
      parents.add(keyOf(cells, first, true));
    }
  }
  for (let cell = 0; cell < count; cell++) {
    leaves[cell] = parents.has(keyOf(opened, NUMBERS_PER_CELL * cell, false)) ? 0 : 1;
  }
  return leaves;
}
