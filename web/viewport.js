// Draws the particles, the octree cells and one particle's tree walk on the
// viewport canvas, and finds the particle under the pointer.

import { SPEED_BANDS, VIEW_RADIUS } from "./settings.js";

const NUMBERS_PER_CELL = 5;
const PICK_RADIUS_PX = 28;
const TAU = 2 * Math.PI;
// Opened cells deeper than this are too small to tell apart.
const MAX_OPENED_DEPTH_DRAWN = 6;

const BAND_COLOURS = Array.from({ length: SPEED_BANDS }, (_, band) => {
  const u = band / (SPEED_BANDS - 1);
  return `oklch(${(0.55 + 0.42 * u).toFixed(3)} ${(0.1 - 0.075 * u).toFixed(3)} 250 / 0.9)`;
});

const cssVariable = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Viewport {
  #canvas;
  #context;
  #setup = "plummer";
  #width = 0;
  #height = 0;
  #ratio = 1;

  constructor(canvas) {
    this.#canvas = canvas;
    this.#context = canvas.getContext("2d");
  }

  // Pixels per length unit for the current setup.
  get scale() {
    return Math.min(this.#width, this.#height) / (2 * VIEW_RADIUS[this.#setup]);
  }

  setup(name) {
    this.#setup = name;
  }

  // Matches the canvas to its CSS size.
  fit() {
    this.#ratio = Math.min(window.devicePixelRatio || 1, 2);
    const box = this.#canvas.getBoundingClientRect();
    this.#width = box.width;
    this.#height = box.height;
    this.#canvas.width = Math.round(box.width * this.#ratio);
    this.#canvas.height = Math.round(box.height * this.#ratio);
  }

  #x(x) {
    return this.#width / 2 + x * this.scale;
  }

  #y(y) {
    return this.#height / 2 - y * this.scale;
  }

  // The index of the particle nearest to a pointer position, or -1 when none
  // is within reach.
  pick(positions, clientX, clientY) {
    const box = this.#canvas.getBoundingClientRect();
    const px = clientX - box.left;
    const py = clientY - box.top;
    let best = -1;
    let bestDistance = PICK_RADIUS_PX * PICK_RADIUS_PX;
    for (let i = 0; i < positions.length / 2; i++) {
      const dx = this.#x(positions[2 * i]) - px;
      const dy = this.#y(positions[2 * i + 1]) - py;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }

  // frame: { positions, bands, cells, probe, trails } from the page.
  draw({ positions, bands, cells, probe, trails, showCells }) {
    const context = this.#context;
    context.setTransform(this.#ratio, 0, 0, this.#ratio, 0, 0);
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, this.#width, this.#height);
    if (!positions) {
      return;
    }
    const count = bands.length;
    if (showCells && cells) {
      this.#drawCells(cells);
    }
    this.#drawTrails(trails);
    this.#drawParticles(positions, bands, count);
    if (probe) {
      this.#drawProbe(probe, positions);
    }
  }

  #cellRectangle(cells, k) {
    const half = (cells[k + 3] / 2) * this.scale;
    return [this.#x(cells[k]) - half, this.#y(cells[k + 1]) - half, 2 * half, 2 * half];
  }

  #drawCells(cells) {
    const context = this.#context;
    context.strokeStyle = cssVariable("--view-tree");
    context.globalAlpha = 0.2;
    context.lineWidth = 1;
    context.beginPath();
    for (let k = 0; k < cells.length; k += NUMBERS_PER_CELL) {
      context.rect(...this.#cellRectangle(cells, k));
    }
    context.stroke();
    context.globalAlpha = 1;
  }

  // The path of each body of a binary, from the positions the page kept.
  #drawTrails(trails) {
    const context = this.#context;
    context.lineWidth = 1.2;
    context.strokeStyle = "oklch(0.7 0.06 250 / 0.5)";
    for (const trail of trails) {
      context.beginPath();
      trail.forEach(([x, y], k) => (k ? context.lineTo(this.#x(x), this.#y(y)) : context.moveTo(this.#x(x), this.#y(y))));
      context.stroke();
    }
  }

  #drawParticles(positions, bands, count) {
    const context = this.#context;
    const isBinary = count <= 8;
    const size = count <= 600 ? 2.4 : count <= 1500 ? 1.9 : 1.5;
    const groups = Array.from({ length: SPEED_BANDS }, () => []);
    for (let i = 0; i < count; i++) {
      groups[bands[i]].push(i);
    }
    context.globalCompositeOperation = "lighter";
    groups.forEach((group, band) => {
      context.fillStyle = BAND_COLOURS[band];
      for (const i of group) {
        const x = this.#x(positions[2 * i]);
        const y = this.#y(positions[2 * i + 1]);
        if (isBinary) {
          context.beginPath();
          context.arc(x, y, 4.5, 0, TAU);
          context.fill();
        } else {
          context.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
    });
    context.globalCompositeOperation = "source-over";
  }

  // The cells one particle's force is summed from: opened cells outlined,
  // accepted cells filled, and a ring round the particle.
  #drawProbe({ index, accepted, opened }, positions) {
    const context = this.#context;
    const colour = cssVariable("--view-tree");
    context.lineWidth = 1;
    for (let k = 0; k < opened.length; k += NUMBERS_PER_CELL) {
      if (opened[k + 4] <= MAX_OPENED_DEPTH_DRAWN) {
        context.globalAlpha = 0.45;
        context.strokeStyle = colour;
        context.strokeRect(...this.#cellRectangle(opened, k));
      }
    }
    for (let k = 0; k < accepted.length; k += NUMBERS_PER_CELL) {
      const rectangle = this.#cellRectangle(accepted, k);
      context.globalAlpha = 0.16;
      context.fillStyle = colour;
      context.fillRect(...rectangle);
      context.globalAlpha = 0.9;
      context.strokeStyle = colour;
      context.strokeRect(...rectangle);
    }
    context.globalAlpha = 1;
    context.strokeStyle = "oklch(0.98 0 0)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(this.#x(positions[2 * index]), this.#y(positions[2 * index + 1]), 7, 0, TAU);
    context.stroke();
  }
}
