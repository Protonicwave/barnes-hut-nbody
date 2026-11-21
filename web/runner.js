// Owns one WebAssembly Simulation and turns the page's settings into calls on
// it. The worker runs it off the main thread, and the smoke test drives it
// under Node, so every control's effect on the simulation is tested here.

import {
  REFERENCE_SPEED,
  SPEED_BANDS,
  changeKind,
  energyInterval,
  isEnergyBaselineReset,
  particleCount,
  softening,
  timestep,
} from "./settings.js";
import { openedLeaves, openingTest } from "./scope.js";

// Deepest octree level drawn, and steps between recomputing the cells: the
// tree moves slowly, and building it again costs about one force evaluation.
const OVERLAY_DEPTH = 5;
const CELL_REFRESH_STEPS = 4;

// The force comparison runs on this frame after a restart and then on every
// REMEASURE_FRAMES-th frame: it times a direct and a tree evaluation.
const FIRST_MEASURE_FRAME = 12;
const REMEASURE_FRAMES = 150;

const MIN_TIMING_MS = 0.001;

export class Runner {
  #module;
  #now;
  #settings;
  #simulation = null;
  #stepsTaken = 0;
  #frames = 0;
  #baseline = 0;
  #seriesId = 0;
  #pendingSamples = [];
  #stepsSinceCells = Infinity;
  #measureAgain = false;
  #lastMeasuredFrame = 0;

  constructor(module, settings, now = () => performance.now()) {
    this.#module = module;
    this.#now = now;
    this.#settings = settings;
    this.#create();
  }

  // Applies new settings and returns what kind of change they were.
  change(next) {
    const kind = changeKind(this.#settings, next);
    this.#settings = next;
    if (kind === "restart") {
      this.#simulation.delete();
      this.#create();
      return kind;
    }
    if (kind === "method" || kind === "tune") {
      this.#simulation.setForceSettings(next.method, next.theta, next.threads);
      this.#measureAgain = true;
    }
    if (isEnergyBaselineReset(kind)) {
      this.#baseline = this.#simulation.energy();
      this.#startSeries();
    }
    return kind;
  }

  close() {
    this.#simulation.delete();
  }

  // Takes up to `steps` steps, stopping early once `budgetMs` has passed, and
  // returns the message for the page and the buffers to transfer with it.
  frame({ steps, budgetMs, probe, wantCells, resendCells = false }) {
    const taken = this.#advance(steps, budgetMs);
    if (taken > 0) {
      this.#frames += 1;
      this.#stepsSinceCells += taken;
    }
    const count = particleCount(this.#settings);
    const { positions, bands } = this.#snapshot(count);
    const message = {
      type: "frame",
      time: this.#simulation.time(),
      count,
      seriesId: this.#seriesId,
      samples: this.#pendingSamples,
      positions,
      bands,
      cells: this.#cells(wantCells, resendCells),
      probe: this.#probe(probe, count),
      measurement: this.#measurementDue() ? this.#measure() : null,
    };
    this.#pendingSamples = [];
    return { message, transfer: transferables(message) };
  }

  #create() {
    const s = this.#settings;
    this.#simulation = this.#module.Simulation.create(
      s.setup, particleCount(s), s.seed, s.method, s.theta, softening(s), timestep(s), s.threads);
    this.#baseline = this.#simulation.initialEnergy();
    this.#stepsTaken = 0;
    this.#frames = 0;
    this.#stepsSinceCells = Infinity;
    this.#measureAgain = false;
    this.#lastMeasuredFrame = 0;
    this.#startSeries();
  }

  #startSeries() {
    this.#seriesId += 1;
    this.#pendingSamples = [];
  }

  #advance(steps, budgetMs) {
    const start = this.#now();
    const interval = energyInterval(particleCount(this.#settings));
    let taken = 0;
    while (taken < steps) {
      this.#simulation.step(1);
      taken += 1;
      this.#stepsTaken += 1;
      if (this.#stepsTaken % interval === 0) {
        const error = Math.abs(this.#simulation.energy() - this.#baseline) / Math.abs(this.#baseline);
        this.#pendingSamples.push([this.#simulation.time(), error]);
      }
      if (this.#now() - start > budgetMs) {
        break;
      }
    }
    return taken;
  }

  // Positions as x and y in single precision, and each particle's speed as a
  // colour band. The views point into the heap, so they are read now.
  #snapshot(count) {
    const positions = new Float32Array(2 * count);
    const bands = new Uint8Array(count);
    const heapPositions = this.#simulation.positions();
    const heapVelocities = this.#simulation.velocities();
    const reference = REFERENCE_SPEED[this.#settings.setup];
    for (let i = 0; i < count; i++) {
      positions[2 * i] = heapPositions[3 * i];
      positions[2 * i + 1] = heapPositions[3 * i + 1];
      const speed = Math.hypot(heapVelocities[3 * i], heapVelocities[3 * i + 1], heapVelocities[3 * i + 2]);
      bands[i] = Math.min(SPEED_BANDS - 1, Math.floor(Math.min(1, speed / reference) * SPEED_BANDS));
    }
    return { positions, bands };
  }

  // The octree cells to draw, or null when the page has them already, does
  // not want them, or the setup has no tree worth drawing.
  #cells(wanted, resend) {
    if (!wanted || this.#settings.setup === "kepler") {
      this.#stepsSinceCells = Infinity;
      return null;
    }
    if (resend) {
      this.#stepsSinceCells = Infinity;
    }
    if (this.#stepsSinceCells < CELL_REFRESH_STEPS) {
      return null;
    }
    this.#stepsSinceCells = 0;
    return this.#simulation.treeCells(OVERLAY_DEPTH);
  }

  // The tree walk of one particle, with the opening test of its largest
  // accepted cell. Null when there is no tree to walk: a binary, or direct
  // summation.
  #probe(index, count) {
    const { setup, method, theta } = this.#settings;
    if (!(index >= 0 && index < count) || setup === "kepler" || method === "direct") {
      return null;
    }
    const trace = this.#simulation.walkTrace(index);
    const position = this.#simulation.positions().slice(3 * index, 3 * index + 3);
    return {
      index,
      interactions: trace.interactions,
      accepted: trace.accepted,
      acceptedCentresOfMass: trace.acceptedCentresOfMass,
      opened: trace.opened,
      openedLeaves: openedLeaves(trace.opened, trace.accepted),
      test: openingTest(trace.accepted, trace.acceptedCentresOfMass, position, theta),
    };
  }

  // Paused frames repeat the frame count, so a frame is measured once.
  #measurementDue() {
    const frames = this.#frames;
    const scheduled = frames !== this.#lastMeasuredFrame &&
      (frames === FIRST_MEASURE_FRAME || (frames > 0 && frames % REMEASURE_FRAMES === 0));
    const due = this.#measureAgain || scheduled;
    this.#measureAgain = false;
    if (due) {
      this.#lastMeasuredFrame = frames;
    }
    return due;
  }

  // Times one direct and one tree evaluation on the current positions, then
  // compares the tree's forces with direct summation's.
  #measure() {
    const simulation = this.#simulation;
    const directMs = this.#timed(() => simulation.evaluateForces("direct"));
    const treeMs = this.#timed(() => simulation.evaluateForces("tree"));
    const { medianError, p99Error, meanInteractions } = simulation.compare("tree");
    return { count: particleCount(this.#settings), directMs, treeMs, medianError, p99Error, meanInteractions };
  }

  #timed(work) {
    const start = this.#now();
    work();
    return Math.max(this.#now() - start, MIN_TIMING_MS);
  }
}

function transferables(message) {
  const buffers = [message.positions.buffer, message.bands.buffer];
  if (message.cells) {
    buffers.push(message.cells.buffer);
  }
  if (message.probe) {
    buffers.push(
      message.probe.accepted.buffer,
      message.probe.acceptedCentresOfMass.buffer,
      message.probe.opened.buffer,
      message.probe.openedLeaves.buffer);
  }
  return buffers;
}
