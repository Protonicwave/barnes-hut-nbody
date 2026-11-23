// Draws the figure's three canvas layers and finds the particle under the
// pointer. Bottom to top: the graticule, redrawn only when the size changes;
// the particles, which keep a fading history of earlier frames; and the
// overlay, redrawn every frame, with the octree cells, one particle's tree
// walk and the opening test written beside it.

import { NUMBERS_PER_CELL } from "./scope.js";
import { SPEED_BANDS, VIEW_RADIUS } from "./settings.js";

const PICK_RADIUS_PX = 28;
const TAU = 2 * Math.PI;

// Each stepped frame fades what is already on the particle layer by this much,
// so a particle leaves a trail of about five frames.
const PERSISTENCE_FADE = 0.45;

// The graticule: a dotted line at every unit, ticks at every quarter unit on
// the bottom and left edges, labels at the whole units.
const TICKS_PER_UNIT = 4;
const MAJOR_TICK_PX = 9;
const MINOR_TICK_PX = 4;
const TICK_LABEL_INSET_PX = 13;
const TICK_LABEL_MARGIN_UNITS = 0.3;
const MONOSPACE = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

const MARK_RADIUS_PX = 6;
const MARK_TICK_INNER_PX = 7;
const MARK_TICK_OUTER_PX = 11;
const TEST_LABEL_OFFSET_PX = 14;
const TEST_LABEL_FLIP_MARGIN_PX = 150;

const BAND_COLOURS = Array.from({ length: SPEED_BANDS }, (_, band) => {
  const u = band / (SPEED_BANDS - 1);
  return `oklch(${(0.55 + 0.42 * u).toFixed(3)} ${(0.1 - 0.075 * u).toFixed(3)} 250 / 0.9)`;
});

const cssVariable = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Viewport {
  #graticule;
  #particles;
  #overlay;
  #persistence;
  #setup = "plummer";
  #width = 0;
  #height = 0;
  #ratio = 1;
  #colours = null;
  #particlesAreStale = true;

  // persistence: whether the particle layer keeps a fading history.
  constructor({ graticule, particles, overlay }, { persistence }) {
    this.#graticule = graticule.getContext("2d");
    this.#particles = particles.getContext("2d");
    this.#overlay = overlay.getContext("2d");
    this.#persistence = persistence;
  }

  // Pixels per length unit for the current setup.
  get scale() {
    return Math.min(this.#width, this.#height) / (2 * VIEW_RADIUS[this.#setup]);
  }

  setup(name) {
    this.#setup = name;
    this.#particlesAreStale = true;
  }

  // Matches the layers to their CSS size and draws the graticule.
  fit() {
    this.#ratio = Math.min(window.devicePixelRatio || 1, 2);
    const box = this.#overlay.canvas.getBoundingClientRect();
    this.#width = box.width;
    this.#height = box.height;
    for (const { canvas } of [this.#graticule, this.#particles, this.#overlay]) {
      canvas.width = Math.round(box.width * this.#ratio);
      canvas.height = Math.round(box.height * this.#ratio);
    }
    this.#colours = {
      background: cssVariable("--view-bg"),
      ink: cssVariable("--view-ink"),
      dim: cssVariable("--view-dim"),
      grid: cssVariable("--view-grid"),
      axis: cssVariable("--view-axis"),
      tree: cssVariable("--view-tree"),
    };
    this.#particlesAreStale = true;
    this.#drawGraticule();
  }

  #x(x) {
    return this.#width / 2 + x * this.scale;
  }

  #y(y) {
    return this.#height / 2 - y * this.scale;
  }

  #prepare(context) {
    context.setTransform(this.#ratio, 0, 0, this.#ratio, 0, 0);
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
  }

  // The index of the particle nearest to a pointer position, or -1 when none
  // is within reach.
  pick(positions, clientX, clientY) {
    const box = this.#overlay.canvas.getBoundingClientRect();
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

  // The page's frame: positions and speed bands, whether the particles moved
  // since the last draw, the marked particle's index, its tree walk, the
  // octree cells, and the trails of a binary.
  draw({ positions, bands, stepped, mark, probe, cells, trails, showCells }) {
    const overlay = this.#overlay;
    this.#prepare(overlay);
    overlay.clearRect(0, 0, this.#width, this.#height);
    if (!positions) {
      this.#prepare(this.#particles);
      this.#particles.clearRect(0, 0, this.#width, this.#height);
      this.#particlesAreStale = true;
      return;
    }
    if (stepped || this.#particlesAreStale) {
      this.#paintParticles(positions, bands, stepped);
    }
    if (showCells && cells) {
      this.#drawCells(cells);
    }
    this.#drawTrails(trails);
    if (probe) {
      this.#drawWalk(probe);
    }
    if (mark >= 0) {
      this.#drawMark(positions, mark, probe);
    }
  }

  #drawGraticule() {
    const context = this.#graticule;
    const colours = this.#colours;
    const width = this.#width;
    const height = this.#height;
    const k = this.scale;
    const halfWidthUnits = width / (2 * k);
    const halfHeightUnits = height / (2 * k);
    this.#prepare(context);
    context.clearRect(0, 0, width, height);
    context.lineWidth = 1;

    context.strokeStyle = colours.grid;
    context.setLineDash([1, 4]);
    context.beginPath();
    for (let i = -Math.floor(halfWidthUnits); i <= Math.floor(halfWidthUnits); i++) {
      context.moveTo(this.#x(i) + 0.5, 0);
      context.lineTo(this.#x(i) + 0.5, height);
    }
    for (let i = -Math.floor(halfHeightUnits); i <= Math.floor(halfHeightUnits); i++) {
      context.moveTo(0, this.#y(i) + 0.5);
      context.lineTo(width, this.#y(i) + 0.5);
    }
    context.stroke();

    context.setLineDash([]);
    context.strokeStyle = colours.axis;
    context.beginPath();
    context.moveTo(this.#x(0) + 0.5, 0);
    context.lineTo(this.#x(0) + 0.5, height);
    context.moveTo(0, this.#y(0) + 0.5);
    context.lineTo(width, this.#y(0) + 0.5);
    context.stroke();

    context.font = `10px ${MONOSPACE}`;
    context.fillStyle = colours.dim;
    context.textBaseline = "alphabetic";
    this.#drawRuler(context, halfWidthUnits, "x");
    this.#drawRuler(context, halfHeightUnits, "y");
  }

  // Ticks and labels along the bottom edge (x) or the left edge (y).
  #drawRuler(context, halfUnits, axis) {
    const colours = this.#colours;
    const isX = axis === "x";
    const last = Math.floor(halfUnits * TICKS_PER_UNIT);
    for (const major of [false, true]) {
      context.strokeStyle = major ? colours.axis : colours.grid;
      context.beginPath();
      for (let i = -last; i <= last; i++) {
        if ((i % TICKS_PER_UNIT === 0) !== major) {
          continue;
        }
        const at = isX ? this.#x(i / TICKS_PER_UNIT) + 0.5 : this.#y(i / TICKS_PER_UNIT) + 0.5;
        const length = major ? MAJOR_TICK_PX : MINOR_TICK_PX;
        context.moveTo(isX ? at : 0, isX ? this.#height : at);
        context.lineTo(isX ? at : length, isX ? this.#height - length : at);
      }
      context.stroke();
    }
    context.textAlign = isX ? "center" : "left";
    for (let unit = -Math.floor(halfUnits - TICK_LABEL_MARGIN_UNITS); unit <= halfUnits - TICK_LABEL_MARGIN_UNITS; unit++) {
      if (unit !== 0) {
        context.fillText(String(unit),
          isX ? this.#x(unit) : TICK_LABEL_INSET_PX,
          isX ? this.#height - TICK_LABEL_INSET_PX : this.#y(unit) + 3.5);
      }
    }
  }

  // Draws the speed-banded particles, after fading the history when the
  // particles have moved and the layer is not being started afresh.
  #paintParticles(positions, bands, stepped) {
    const context = this.#particles;
    this.#prepare(context);
    if (this.#persistence && stepped && !this.#particlesAreStale) {
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = `rgb(0 0 0 / ${PERSISTENCE_FADE})`;
      context.fillRect(0, 0, this.#width, this.#height);
      context.globalCompositeOperation = "source-over";
    } else {
      context.clearRect(0, 0, this.#width, this.#height);
    }
    this.#particlesAreStale = false;

    const count = bands.length;
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

  #cellRectangle(cells, k) {
    const half = (cells[k + 3] / 2) * this.scale;
    return [this.#x(cells[k]) - half, this.#y(cells[k + 1]) - half, 2 * half, 2 * half];
  }

  #drawCells(cells) {
    const context = this.#overlay;
    context.strokeStyle = this.#colours.tree;
    context.globalAlpha = 0.2;
    context.beginPath();
    for (let k = 0; k < cells.length; k += NUMBERS_PER_CELL) {
      context.rect(...this.#cellRectangle(cells, k));
    }
    context.stroke();
    context.globalAlpha = 1;
  }

  // The path of each body of a binary, from the positions the page kept.
  #drawTrails(trails) {
    const context = this.#overlay;
    context.lineWidth = 1.2;
    context.strokeStyle = "oklch(0.7 0.06 250 / 0.5)";
    for (const trail of trails) {
      context.beginPath();
      trail.forEach(([x, y], k) => (k ? context.lineTo(this.#x(x), this.#y(y)) : context.moveTo(this.#x(x), this.#y(y))));
      context.stroke();
    }
  }

  // The cells one particle's force is summed from: opened cells thin, opened
  // cells that were leaves dashed, accepted cells washed.
  #drawWalk({ accepted, opened, openedLeaves }) {
    const context = this.#overlay;
    const tree = this.#colours.tree;
    context.lineWidth = 1;
    context.strokeStyle = tree;
    for (const leaves of [false, true]) {
      context.setLineDash(leaves ? [2, 3] : []);
      context.globalAlpha = leaves ? 0.4 : 0.2;
      context.beginPath();
      for (let cell = 0; cell < openedLeaves.length; cell++) {
        if ((openedLeaves[cell] === 1) === leaves) {
          context.rect(...this.#cellRectangle(opened, NUMBERS_PER_CELL * cell));
        }
      }
      context.stroke();
    }
    context.setLineDash([]);
    context.fillStyle = tree;
    context.globalAlpha = 0.05;
    context.beginPath();
    for (let k = 0; k < accepted.length; k += NUMBERS_PER_CELL) {
      context.rect(...this.#cellRectangle(accepted, k));
    }
    context.fill();
    context.globalAlpha = 0.75;
    context.stroke();
    context.globalAlpha = 1;
  }

  // The ring round the marked particle and, when the walk accepted a cell,
  // the opening test: the cell's edge s, the line to its centre of mass d, and
  // the ratio the code compares with theta.
  #drawMark(positions, mark, probe) {
    const context = this.#overlay;
    const x = this.#x(positions[2 * mark]);
    const y = this.#y(positions[2 * mark + 1]);
    context.strokeStyle = this.#colours.ink;
    context.lineWidth = 1;
    context.beginPath();
    context.arc(x, y, MARK_RADIUS_PX, 0, TAU);
    context.moveTo(x - MARK_TICK_OUTER_PX, y);
    context.lineTo(x - MARK_TICK_INNER_PX, y);
    context.moveTo(x + MARK_TICK_INNER_PX, y);
    context.lineTo(x + MARK_TICK_OUTER_PX, y);
    context.stroke();
    if (probe?.test) {
      this.#drawOpeningTest(probe, x, y);
    }
  }

  #drawOpeningTest({ accepted, acceptedCentresOfMass, test }, x, y) {
    const context = this.#overlay;
    const amber = this.#colours.tree;
    const first = NUMBERS_PER_CELL * test.cell;
    const half = accepted[first + 3] / 2;
    const left = this.#x(accepted[first] - half);
    const right = this.#x(accepted[first] + half);
    const bracketY = this.#y(accepted[first + 1] + half) + 9;
    const massX = this.#x(acceptedCentresOfMass[3 * test.cell]);
    const massY = this.#y(acceptedCentresOfMass[3 * test.cell + 1]);

    context.strokeStyle = amber;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(left + 3, bracketY);
    context.lineTo(right - 3, bracketY);
    context.moveTo(left + 3, bracketY - 4);
    context.lineTo(left + 3, bracketY + 4);
    context.moveTo(right - 3, bracketY - 4);
    context.lineTo(right - 3, bracketY + 4);
    context.stroke();
    this.#label("s", (left + right) / 2, bracketY + 11, "center");

    context.setLineDash([4, 3]);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(massX, massY);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = amber;
    context.beginPath();
    context.arc(massX, massY, 3, 0, TAU);
    context.fill();
    this.#label("d", (x + massX) / 2 + 8, (y + massY) / 2 - 8, "left");

    const flipped = x > this.#width - TEST_LABEL_FLIP_MARGIN_PX;
    const text = `s/(d − δ) = ${test.ratio.toFixed(2)} < θ = ${test.theta.toFixed(2)}`;
    this.#label(text, x + (flipped ? -TEST_LABEL_OFFSET_PX : TEST_LABEL_OFFSET_PX), y + 16, flipped ? "right" : "left");
  }

  // Text in the tree colour on a halo of the glass colour, so it reads over
  // the particles.
  #label(text, x, y, align) {
    const context = this.#overlay;
    context.font = `11px ${MONOSPACE}`;
    context.textAlign = align;
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 4;
    context.strokeStyle = this.#colours.background;
    context.strokeText(text, x, y);
    context.fillStyle = this.#colours.tree;
    context.fillText(text, x, y);
  }
}
