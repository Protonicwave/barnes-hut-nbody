// Loads both WebAssembly builds under Node and drives them through Embind.
// Build them first: cmake --workflow --preset wasm-threads, then wasm-single.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { Runner } from "../runner.js";
import {
  DEFAULT_SETTINGS,
  PARTICLE_COUNTS,
  SOFTENING_SCALES,
  TIMESTEP_LABELS,
  VIEW_RADIUS,
  controlState,
  labels,
  moduleState,
  particleCount,
  wholeTreeShown,
  withChange,
} from "../settings.js";
import { readFileSync } from "node:fs";
import { decadeFraction, figureCaptions } from "../charts.js";
import { runRecord } from "../record.js";
import { defaultMarkedParticle, openedLeaves, openingTest, walkCounts } from "../scope.js";
import createThreaded from "../wasm/threads/nbody.js";
import createSingle from "../wasm/single/nbody.js";

const DT = 1 / 128;
const COUNT = 1024;
const STEPS = 8;

const threaded = await createThreaded();
const single = await createSingle();

// The pool workers of the threaded build keep Node alive until told to stop.
after(() => threaded.PThread.terminateAllThreads());

const plummer = (module, threads = 1, method = "tree") =>
  module.Simulation.create("plummer", COUNT, 1, method, 0.5, 4 / Math.sqrt(COUNT), DT, threads);

describe("both builds", () => {
  for (const [name, module, threads] of [["single", single, 1], ["threaded", threaded, 8]]) {
    it(`${name}: steps a Plummer sphere and reads views of 3 * N doubles`, () => {
      const simulation = plummer(module, threads);
      simulation.step(STEPS);
      assert.equal(simulation.size(), COUNT);
      assert.equal(simulation.positions().length, 3 * COUNT);
      assert.equal(simulation.velocities().length, 3 * COUNT);
      assert.ok(Number.isFinite(simulation.energy()));
      assert.ok(Math.abs(simulation.time() - STEPS * DT) < 1e-12);
      simulation.delete();
    });

    it(`${name}: starts near the virial energy and drifts by little`, () => {
      const simulation = plummer(module, threads);
      const start = simulation.initialEnergy();
      // Softening lifts the energy of the virial -1/4 a little.
      assert.ok(start > -0.25 && start < -0.2, `initial energy ${start}`);
      simulation.step(64);
      assert.ok(Math.abs(simulation.energy() - start) / Math.abs(start) < 1e-3);
      simulation.delete();
    });

    it(`${name}: builds each setup`, () => {
      const collapse = module.Simulation.create("collapse", 256, 1, "direct", 0.5, 0.25, DT, 1);
      const kepler = module.Simulation.create("kepler", 0, 0, "direct", 0.5, 0, DT, 1);
      assert.equal(collapse.size(), 256);
      assert.equal(kepler.size(), 2);
      collapse.delete();
      kepler.delete();
    });

    it(`${name}: rejects each invalid argument with a message naming the value`, () => {
      const create = (...replacement) => {
        const base = ["plummer", 256, 1, "tree", 0.5, 0.25, DT, 1];
        base.splice(0, replacement.length, ...replacement);
        return module.Simulation.create(...base);
      };
      assert.throws(() => create("spiral"), /setup.*"spiral"/);
      assert.throws(() => create("plummer", 0), /count.*got 0/);
      assert.throws(() => create("plummer", -1), /count.*got -1/);
      assert.throws(() => create("plummer", 2.5), /count.*got 2\.5/);
      assert.throws(() => create("plummer", 256, -1), /seed.*got -1/);
      assert.throws(() => create("plummer", module.MAX_PARTICLES + 1), /count.*got 65537/);
      assert.throws(() => create("plummer", 256, 1, "fmm"), /method.*"fmm"/);
      assert.throws(() => create("plummer", 256, 1, "tree", 1.5), /1\.5/);
      assert.throws(() => create("plummer", 256, 1, "tree", 0.5, 0.25, DT, 0), /threads.*got 0/);
      assert.throws(() => create("plummer", 256, 1, "tree", 0.5, 0.25, DT, module.MAX_THREADS + 1),
        new RegExp(`threads.*got ${module.MAX_THREADS + 1}`));
      const simulation = create();
      assert.throws(() => simulation.step(0), /steps.*got 0/);
      assert.throws(() => simulation.step(module.MAX_STEPS_PER_CALL + 1), /steps.*got 1025/);
      simulation.delete();
    });
  }

  for (const [name, module] of [["single", single], ["threaded", threaded]]) {
    it(`${name}: changes method and theta on a running simulation and keeps the time`, () => {
      const simulation = plummer(module, 1, "direct");
      simulation.step(4);
      simulation.setForceSettings("tree", 0.7, 1);
      assert.ok(Math.abs(simulation.time() - 4 * DT) < 1e-12);
      simulation.step(4);
      assert.ok(Math.abs(simulation.time() - 8 * DT) < 1e-12);
      assert.throws(() => simulation.setForceSettings("fmm", 0.5, 1), /method.*"fmm"/);
      assert.throws(() => simulation.setForceSettings("tree", 1.5, 1), /1\.5/);
      assert.throws(() => simulation.setForceSettings("tree", 0.5, 0), /threads.*got 0/);
      simulation.delete();
    });

    it(`${name}: compares the named method with direct summation`, () => {
      const exact = module.Simulation.create("plummer", 512, 1, "tree", 0, 0.1, DT, 1);
      const { medianError, p99Error, meanInteractions } = exact.compare("tree");
      assert.ok(medianError < 1e-12 && p99Error < 1e-12);
      assert.equal(meanInteractions, 511);
      exact.delete();

      const approximate = plummer(module);
      const result = approximate.compare("tree");
      assert.ok(result.medianError > 0 && result.medianError < 5e-3);
      assert.ok(result.p99Error >= result.medianError);
      assert.ok(result.meanInteractions < COUNT - 1);
      assert.equal(approximate.compare("direct").medianError, 0);
      assert.throws(() => approximate.compare("fmm"), /method.*"fmm"/);
      approximate.delete();
    });

    it(`${name}: reports octree cells and the walk for one particle`, () => {
      const simulation = plummer(module);
      const cells = simulation.treeCells(4);
      assert.ok(cells.length > 0 && cells.length % 5 === 0);
      const depths = new Set();
      for (let c = 4; c < cells.length; c += 5) depths.add(cells[c]);
      assert.deepEqual([...depths].sort(), [2, 3, 4]);
      assert.throws(() => simulation.treeCells(1), /depth.*got 1/);
      assert.throws(() => simulation.treeCells(6), /depth.*got 6/);

      const trace = simulation.walkTrace(3);
      assert.ok(trace.interactions > 0 && trace.interactions < COUNT - 1);
      assert.ok(trace.opened.length > 0);
      assert.throws(() => simulation.walkTrace(COUNT), new RegExp(`index.*got ${COUNT}`));
      assert.throws(() => simulation.walkTrace(-1), /index.*got -1/);
      simulation.delete();
    });

    it(`${name}: reports the centre of mass of each accepted cell, which passes the opening test`, () => {
      const theta = 0.5;
      const simulation = plummer(module);
      const { accepted, acceptedCentresOfMass } = simulation.walkTrace(3);
      assert.ok(accepted.length > 0);
      assert.equal(acceptedCentresOfMass.length, (accepted.length / 5) * 3);
      const position = simulation.positions().slice(9, 12);
      for (let cell = 0; cell < accepted.length / 5; cell++) {
        const edge = accepted[5 * cell + 3];
        const centre = accepted.slice(5 * cell, 5 * cell + 3);
        const mass = acceptedCentresOfMass.slice(3 * cell, 3 * cell + 3);
        const distance = Math.hypot(...position.map((x, axis) => x - mass[axis]));
        const offset = Math.hypot(...mass.map((x, axis) => x - centre[axis]));
        assert.ok(distance * theta > edge + theta * offset, `cell ${cell} fails the opening test`);
      }
      simulation.delete();
    });

    it(`${name}: reports total momentum and centre of mass as three numbers near zero`, () => {
      const simulation = plummer(module);
      for (const vector of [simulation.momentum(), simulation.centreOfMass()]) {
        assert.equal(vector.length, 3);
        assert.ok([...vector].every((x) => Math.abs(x) < 1e-15), `${vector}`);
      }
      simulation.delete();
    });

    it(`${name}: evaluates forces by either method for timing`, () => {
      const simulation = plummer(module);
      simulation.evaluateForces("direct");
      simulation.evaluateForces("tree");
      assert.throws(() => simulation.evaluateForces("fmm"), /method.*"fmm"/);
      simulation.delete();
    });
  }

  it("reports the thread limit of each build", () => {
    assert.equal(single.MAX_THREADS, 1);
    assert.equal(threaded.MAX_THREADS, 8);
  });
});

describe("threaded against single-threaded", () => {
  for (const method of ["tree", "direct"]) {
    it(`${method} positions are bitwise identical after ${STEPS} steps`, () => {
      const one = plummer(single, 1, method);
      const eight = plummer(threaded, 8, method);
      one.step(STEPS);
      eight.step(STEPS);
      assert.deepEqual(Array.from(one.positions()), Array.from(eight.positions()));
      assert.equal(one.energy(), eight.energy());
      one.delete();
      eight.delete();
    });
  }
});

// A module that records the calls the page's controls make on its Simulation.
function recording(module) {
  const calls = [];
  const create = (...args) => {
    calls.push(["create", ...args]);
    const simulation = module.Simulation.create(...args);
    return new Proxy(simulation, {
      get(target, name) {
        const member = target[name];
        return typeof member === "function"
          ? (...call) => { calls.push([name, ...call]); return member.apply(target, call); }
          : member;
      },
    });
  };
  return { calls, MAX_THREADS: module.MAX_THREADS, Simulation: { create } };
}

const SMALL = { ...DEFAULT_SETTINGS, countIndex: 0, threads: 1 };
const lastCall = (calls, name) => calls.findLast((call) => call[0] === name);
const frame = (runner, request = {}) =>
  runner.frame({ steps: 1, budgetMs: 1000, probe: -1, wantCells: false, ...request }).message;

describe("page controls reach the simulation with the value their label shows", () => {
  it("theta keeps the particles and the time, rounded to its grid", () => {
    const module = recording(single);
    const runner = new Runner(module, SMALL);
    frame(runner, { steps: 4 });
    const next = withChange(SMALL, "theta", 0.30000000000000004);
    assert.equal(runner.change(next), "tune");
    assert.equal(labels(next).theta, "0.3");
    assert.deepEqual(lastCall(module.calls, "setForceSettings"), ["setForceSettings", "tree", 0.3, 1]);
    assert.equal(module.calls.filter((call) => call[0] === "create").length, 1);
    assert.ok(Math.abs(frame(runner, { steps: 0 }).time - 4 / 128) < 1e-12);
    runner.close();
  });

  it("method keeps the particles and starts a new energy series", () => {
    const module = recording(single);
    const runner = new Runner(module, SMALL);
    const before = frame(runner, { steps: 16 });
    assert.equal(before.samples.length, 1);
    const next = withChange(SMALL, "method", "direct");
    assert.equal(runner.change(next), "method");
    assert.deepEqual(lastCall(module.calls, "setForceSettings"), ["setForceSettings", "direct", 0.5, 1]);
    assert.equal(labels(next).theta, "0.5");
    assert.equal(controlState(next).thetaDisabled, true);
    const after = frame(runner, { steps: 0 });
    assert.notEqual(after.seriesId, before.seriesId);
    assert.equal(after.samples.length, 0);
    runner.close();
  });

  it("softening is k over the square root of N for each choice", () => {
    for (const scale of SOFTENING_SCALES) {
      const module = recording(single);
      const runner = new Runner(module, SMALL);
      const next = withChange(SMALL, "softeningScale", scale);
      runner.change(next);
      const [, , count, , , , softening] = lastCall(module.calls, "create");
      assert.equal(softening, scale / Math.sqrt(count));
      assert.equal(labels(next).softening, softening.toFixed(3));
      runner.close();
    }
  });

  it("particle count is the number the label shows", () => {
    for (let countIndex = 1; countIndex < 4; countIndex++) {
      const module = recording(single);
      const runner = new Runner(module, SMALL);
      const next = withChange(SMALL, "countIndex", countIndex);
      assert.equal(runner.change(next), "restart");
      const [, , count] = lastCall(module.calls, "create");
      assert.equal(count, Number(labels(next).count.replaceAll(",", "")));
      assert.equal(frame(runner).count, particleCount(next));
      runner.close();
    }
    assert.equal(PARTICLE_COUNTS.length, 6);
  });

  it("timestep is the fraction the label shows", () => {
    TIMESTEP_LABELS.forEach((label, timestepIndex) => {
      if (timestepIndex === SMALL.timestepIndex) {
        return;
      }
      const module = recording(single);
      const runner = new Runner(module, SMALL);
      runner.change(withChange(SMALL, "timestepIndex", timestepIndex));
      const [numerator, denominator] = label.split("/").map(Number);
      assert.equal(lastCall(module.calls, "create")[7], numerator / denominator);
      runner.close();
    });
  });

  it("a new seed restarts with the seed the label shows", () => {
    const module = recording(single);
    const runner = new Runner(module, SMALL);
    const next = withChange(SMALL, "seed", 2);
    assert.equal(runner.change(next), "restart");
    assert.equal(lastCall(module.calls, "create")[3], 2);
    assert.equal(labels(next).seed, "seed 2");
    runner.close();
  });

  it("the whole tree is drawn only for the tree on a non-Kepler setup with the toggle on", () => {
    const tree = withChange(SMALL, "method", "tree");
    assert.equal(wholeTreeShown(true, tree), true);
    assert.equal(wholeTreeShown(false, tree), false);
    assert.equal(wholeTreeShown(true, withChange(tree, "method", "direct")), false);
    assert.equal(wholeTreeShown(true, withChange(tree, "setup", "kepler")), false);
  });

  it("the whole tree button is disabled under direct summation and hidden for Kepler", () => {
    const tree = withChange(SMALL, "method", "tree");
    assert.equal(controlState(tree).cellsDisabled, false);
    assert.equal(controlState(withChange(tree, "method", "direct")).cellsDisabled, true);
    assert.equal(controlState(tree).cellsHidden, false);
    assert.equal(controlState(withChange(tree, "setup", "kepler")).cellsHidden, true);
  });

  it("the Kepler setup builds two bodies and disables N and softening", () => {
    const module = recording(single);
    const runner = new Runner(module, SMALL);
    const next = withChange(SMALL, "setup", "kepler");
    runner.change(next);
    const create = lastCall(module.calls, "create");
    assert.equal(create[1], "kepler");
    assert.equal(create[6], 0);
    assert.equal(labels(next).softening, "0");
    assert.equal(labels(next).count, "2");
    assert.deepEqual(
      [controlState(next).countDisabled, controlState(next).softeningDisabled, controlState(next).cellsHidden],
      [true, true, true]);
    assert.equal(controlState(SMALL).countDisabled, false);
    const message = frame(runner, { steps: 2, wantCells: true, probe: 0 });
    assert.equal(message.count, 2);
    assert.equal(message.cells, null);
    assert.equal(message.probe, null);
    runner.close();
  });

  it("warns above theta 0.7 only while the tree is in use", () => {
    assert.equal(controlState(withChange(SMALL, "theta", 0.8)).thetaWarning, true);
    assert.equal(controlState(withChange(SMALL, "theta", 0.7)).thetaWarning, false);
    const direct = withChange(withChange(SMALL, "theta", 0.9), "method", "direct");
    assert.equal(controlState(direct).thetaWarning, false);
  });
});

describe("conservation and the force change time in a frame", () => {
  const direct = withChange(SMALL, "method", "direct");

  it("conservation is all zero on the first frame", () => {
    const runner = new Runner(single, SMALL);
    assert.deepEqual(frame(runner, { steps: 0 }).conservation, { energy: 0, momentum: 0, centre: 0 });
    runner.close();
  });

  it("direct summation changes the momentum by under 1e-12, and energy is the last sample", () => {
    const runner = new Runner(single, direct);
    const message = frame(runner, { steps: 32 });
    const { conservation } = message;
    assert.ok(conservation.momentum < 1e-12, `momentum ${conservation.momentum}`);
    assert.ok(conservation.centre < 1e-12, `centre ${conservation.centre}`);
    assert.equal(message.samples.length, 2);
    assert.equal(conservation.energy, message.samples.at(-1)[1]);
    assert.ok(conservation.energy > 0);
    runner.close();
  });

  it("a method change measures from the current state, so every reading is zero again", () => {
    const runner = new Runner(single, SMALL);
    assert.ok(frame(runner, { steps: 32 }).conservation.energy > 0);
    runner.change(direct);
    assert.deepEqual(frame(runner, { steps: 0 }).conservation, { energy: 0, momentum: 0, centre: 0 });
    runner.close();
  });

  it("forceChangedAt is null after create and restart, the time after theta or method, and unmoved by threads", () => {
    const runner = new Runner(threaded, SMALL);
    frame(runner, { steps: 4 });
    assert.equal(frame(runner, { steps: 0 }).forceChangedAt, null);
    runner.change(withChange(SMALL, "threads", 2));
    assert.equal(frame(runner, { steps: 0 }).forceChangedAt, null);
    const tuned = withChange(SMALL, "theta", 0.3);
    runner.change(tuned);
    const at = frame(runner, { steps: 0 }).forceChangedAt;
    assert.ok(Math.abs(at - 4 / 128) < 1e-12, `${at}`);
    runner.change(withChange(tuned, "threads", 4));
    assert.equal(frame(runner, { steps: 0 }).forceChangedAt, at);
    frame(runner, { steps: 4 });
    runner.change(withChange(tuned, "method", "direct"));
    assert.ok(frame(runner, { steps: 0 }).forceChangedAt > at);
    runner.change(withChange(tuned, "run", 1));
    assert.equal(frame(runner, { steps: 0 }).forceChangedAt, null);
    runner.close();
  });
});

describe("the run record", () => {
  const DEFAULT_RECORD = [
    "import numpy as np",
    "import barnes_hut as bh",
    "",
    "# same seed; the starting particles can differ from this tab by platform",
    "positions, velocities, masses = bh.plummer_sphere(1024, seed=1)",
    "simulation = bh.Simulation(",
    "    positions, velocities, masses,",
    "    dt=1 / 128, softening=4 / np.sqrt(1024),",
    '    method="tree", theta=0.5, threads=8,',
    ")",
    "start = simulation.total_energy()",
    "simulation.step(1600)",
    "print(abs(simulation.total_energy() - start) / abs(start))",
  ].join("\n");

  it("is the README call for the default settings at t = 12.5", () => {
    assert.equal(runRecord(DEFAULT_SETTINGS, 12.5, null), DEFAULT_RECORD);
  });

  it("builds a cold collapse with uniform_sphere and carries every setting", () => {
    const settings = { ...DEFAULT_SETTINGS, setup: "collapse", countIndex: 4, seed: 7, softeningScale: 2, timestepIndex: 2, method: "direct", theta: 0.7, threads: 2 };
    const record = runRecord(settings, 1, null);
    assert.match(record, /bh\.uniform_sphere\(4096, seed=7\)/);
    assert.match(record, /dt=1 \/ 64, softening=2 \/ np\.sqrt\(4096\)/);
    assert.match(record, /method="direct", theta=0\.7, threads=2/);
    assert.match(record, /simulation\.step\(64\)/);
  });

  it("builds the Kepler binary with no softening and no count or seed", () => {
    const record = runRecord({ ...DEFAULT_SETTINGS, setup: "kepler" }, 0.5, null);
    assert.match(record, /bh\.kepler_binary\(eccentricity=0\.5, semi_major_axis=1\.0\)/);
    assert.match(record, /softening=0,/);
    assert.doesNotMatch(record, /seed|sqrt|platform/);
  });

  it("notes a method or theta change only when the force was changed", () => {
    const note = "# method or theta changed at t = 3.25; this call runs the current settings from t = 0";
    assert.ok(!runRecord(DEFAULT_SETTINGS, 12.5, null).includes("changed at"));
    const record = runRecord(DEFAULT_SETTINGS, 12.5, 3.25);
    assert.equal(record, `${note}\n${DEFAULT_RECORD}`);
  });
});

describe("decadeFraction", () => {
  it("places a value on a log scale, clamped to the ends", () => {
    assert.equal(decadeFraction(1e-6, -6, -1), 0);
    assert.ok(Math.abs(decadeFraction(1e-4, -6, -1) - 0.4) < 1e-12);
    assert.equal(decadeFraction(1e-1, -6, -1), 1);
    assert.equal(decadeFraction(0, -6, -1), 0);
    assert.equal(decadeFraction(1e-9, -6, -1), 0);
    assert.equal(decadeFraction(1, -6, -1), 1);
  });
});

describe("figureCaptions", () => {
  const results = JSON.parse(readFileSync(new URL("../data/results.json", import.meta.url), "utf8"));
  const captions = figureCaptions({ ...results, machine: { ...results.machine, cpu: "Test CPU" } });

  it("names the machine and the thread count on the speed and scaling plates and the table", () => {
    for (const text of [captions.time, captions.threads, captions.wasm]) {
      assert.ok(text.includes("Test CPU"), text);
      assert.ok(text.includes("8 threads"), text);
    }
  });

  it("gives the count of the force plate and states no repetition count", () => {
    assert.ok(captions.force.includes("N = 16,384"), captions.force);
    assert.ok(captions.drift.includes("N = 4,096"), captions.drift);
    assert.ok(captions.drift.includes("Δt = 1/128"), captions.drift);
    assert.ok(captions.drift.includes("θ = 0.3, 0.5, 0.7, 1"), captions.drift);
    assert.ok(!Object.values(captions).some((text) => text.includes("repetitions")));
  });
});

describe("page states", () => {
  it("a failed module load shows the failed state with a Reload button and locked controls", () => {
    const state = moduleState("failed", "single", 1);
    assert.deepEqual(
      [state.showFailed, state.showLoading, state.controlsDisabled],
      [true, false, true]);
  });

  it("loading locks the controls and the single-threaded build explains itself", () => {
    assert.deepEqual(
      [moduleState("loading").showLoading, moduleState("loading").controlsDisabled],
      [true, true]);
    const oneThread = moduleState("ready", "single", 1);
    assert.deepEqual(
      [oneThread.showBanner, oneThread.threadsDisabled, oneThread.controlsDisabled],
      [true, true, false]);
    assert.equal(oneThread.badge, "WebAssembly, one thread");
    const threaded = moduleState("ready", "threads", 8);
    assert.deepEqual([threaded.showBanner, threaded.threadsDisabled], [false, false]);
    assert.equal(threaded.badge, "WebAssembly, 8 threads");
  });
});

describe("frames", () => {
  it("carry positions, speed bands, energy samples and the measurement on the twelfth stepped frame", () => {
    const runner = new Runner(single, SMALL);
    let samples = 0;
    for (let k = 1; k <= 12; k++) {
      const message = frame(runner, { steps: 2 });
      samples += message.samples.length;
      assert.equal(message.positions.length, 2 * 256);
      assert.equal(message.bands.length, 256);
      assert.ok(message.bands.every((band) => band >= 0 && band < 14));
      assert.equal(message.measurement === null, k !== 12, `frame ${k}`);
    }
    assert.equal(samples, 1);
    const paused = frame(runner, { steps: 0 });
    assert.equal(paused.measurement, null);
    assert.ok(Math.abs(paused.time - 24 / 128) < 1e-12);
    runner.close();
  });

  it("measure a tree faster than direct with a small error and fewer interactions", () => {
    const larger = { ...SMALL, countIndex: 3 };
    const runner = new Runner(single, larger);
    runner.change({ ...larger, theta: 0.6 });
    const measured = frame(runner, { steps: 0 }).measurement;
    assert.equal(measured.count, 2048);
    assert.ok(measured.directMs > 0 && measured.treeMs > 0);
    assert.ok(measured.medianError > 0 && measured.medianError < 5e-3);
    assert.ok(measured.p99Error >= measured.medianError);
    assert.ok(measured.meanInteractions < 2047);
    assert.equal(frame(runner, { steps: 0 }).measurement, null);
    runner.close();
  });

  it("send octree cells when wanted and a walk for a probed particle", () => {
    const runner = new Runner(single, SMALL);
    assert.equal(frame(runner, { steps: 1 }).cells, null);
    const first = frame(runner, { steps: 1, wantCells: true, probe: 3 });
    assert.ok(first.cells.length > 0 && first.cells.length % 5 === 0);
    assert.ok(first.probe.interactions > 0 && first.probe.interactions < 255);
    assert.ok(first.probe.opened.length > 0 && first.probe.accepted.length > 0);
    assert.equal(frame(runner, { steps: 1, wantCells: true }).cells, null);
    assert.ok(frame(runner, { steps: 4, wantCells: true }).cells.length > 0);
    assert.equal(frame(runner, { probe: 999 }).probe, null);
    runner.close();
  });

  it("stop stepping once the time budget is spent", () => {
    let clock = 0;
    const runner = new Runner(single, SMALL, () => (clock += 5));
    const message = runner.frame({ steps: 16, budgetMs: 12, probe: -1, wantCells: false }).message;
    assert.ok(message.time < 16 / 128);
    assert.ok(message.time > 0);
    runner.close();
  });
});

describe("the scope's claims about one particle's walk", () => {
  const TRACED = 3;
  const traced = (settings = SMALL) => {
    const runner = new Runner(single, settings);
    return { runner, message: frame(runner, { steps: 0, probe: TRACED }) };
  };
  const independentWalk = () => {
    const simulation = single.Simulation.create("plummer", 256, SMALL.seed, "tree", SMALL.theta, 4 / Math.sqrt(256), DT, 1);
    const trace = simulation.walkTrace(TRACED);
    const position = simulation.positions().slice(3 * TRACED, 3 * TRACED + 3);
    simulation.delete();
    return { trace, position };
  };

  it("the probe's opening test is s / (d - delta) for the accepted cell with the largest edge, below theta", () => {
    const { runner, message } = traced();
    const { test } = message.probe;
    const { trace, position } = independentWalk();
    const edges = Array.from({ length: trace.accepted.length / 5 }, (_, cell) => trace.accepted[5 * cell + 3]);
    const mass = trace.acceptedCentresOfMass.slice(3 * test.cell, 3 * test.cell + 3);
    const centre = trace.accepted.slice(5 * test.cell, 5 * test.cell + 3);
    const distance = Math.hypot(...position.map((x, axis) => x - mass[axis]));
    const offset = Math.hypot(...mass.map((x, axis) => x - centre[axis]));
    assert.equal(test.edge, Math.max(...edges));
    assert.ok(Math.abs(test.ratio - test.edge / (distance - offset)) < 1e-12);
    assert.ok(test.ratio < SMALL.theta);
    assert.equal(test.theta, SMALL.theta);
    runner.close();
  });

  it("the probe is absent under direct summation, where there is no walk to show", () => {
    const runner = new Runner(single, SMALL);
    runner.change({ ...SMALL, method: "direct" });
    assert.equal(frame(runner, { steps: 0, probe: TRACED }).probe, null);
    runner.close();
  });

  it("opening test picks the largest edge, then the nearest, and is null with no accepted cell", () => {
    const centres = new Float64Array([0, 0, 0, 4, 0, 0, 1, 0, 0, 0, 0, 0]);
    const accepted = new Float64Array([0, 0, 0, 1, 3, 0, 0, 0, 2, 2, 1, 0, 0, 2, 2, 0, 0, 0, 1, 3]);
    const test = openingTest(accepted, centres, [0, 0, 0], 0.5);
    assert.equal(test.cell, 2);
    assert.equal(test.edge, 2);
    assert.equal(test.distance, 1);
    assert.equal(test.offset, 0);
    assert.equal(test.ratio, 2);
    assert.equal(openingTest(new Float64Array(0), new Float64Array(0), [0, 0, 0], 0.5), null);
  });

  it("walk counts add up to the interactions, give N - 1 for direct and nothing for a binary", () => {
    const { runner, message } = traced();
    const counts = walkCounts(message.probe, message.count, "plummer", "tree");
    assert.equal(counts.cells + counts.particles, message.probe.interactions);
    assert.equal(counts.cells, message.probe.accepted.length / 5);
    assert.deepEqual(walkCounts(null, 256, "plummer", "direct"), { cells: 0, particles: 255 });
    assert.equal(walkCounts(null, 256, "plummer", "tree"), null);
    assert.equal(walkCounts(null, 2, "kepler", "tree"), null);
    assert.equal(walkCounts(null, 2, "kepler", "direct"), null);
    runner.close();
  });

  it("the default mark is the particle nearest the aim point, and absent for a binary or no positions", () => {
    for (const setup of ["plummer", "collapse"]) {
      const runner = new Runner(single, { ...SMALL, setup });
      const { positions } = frame(runner, { steps: 0 });
      const aim = [0.5 * VIEW_RADIUS[setup], -0.25 * VIEW_RADIUS[setup]];
      const distances = Array.from({ length: positions.length / 2 }, (_, i) =>
        Math.hypot(positions[2 * i] - aim[0], positions[2 * i + 1] - aim[1]));
      assert.equal(defaultMarkedParticle(positions, setup), distances.indexOf(Math.min(...distances)));
      runner.close();
    }
    assert.equal(defaultMarkedParticle(new Float32Array([0, 0, 1, 1]), "kepler"), -1);
    assert.equal(defaultMarkedParticle(undefined, "plummer"), -1);
    assert.equal(defaultMarkedParticle(new Float32Array(0), "plummer"), -1);
  });

  it("a leaf is an opened cell with no visited child, and the root is not one", () => {
    const { runner, message } = traced({ ...SMALL, countIndex: 2 });
    const { opened, accepted, openedLeaves: leaves } = message.probe;
    assert.equal(leaves.length, opened.length / 5);
    assert.equal(opened[4], 0);
    assert.equal(leaves[0], 0);
    const children = (first) => {
      const half = opened[first + 3] / 2;
      const inside = (cells, k) => cells[k + 4] === opened[first + 4] + 1 &&
        [0, 1, 2].every((axis) => Math.abs(cells[k + axis] - opened[first + axis]) < half);
      let found = 0;
      for (const cells of [opened, accepted]) {
        for (let k = 0; k < cells.length; k += 5) {
          found += inside(cells, k) ? 1 : 0;
        }
      }
      return found;
    };
    let leafCount = 0;
    for (let cell = 0; cell < leaves.length; cell++) {
      assert.equal(leaves[cell] === 1, children(5 * cell) === 0, `cell ${cell}`);
      leafCount += leaves[cell];
    }
    assert.ok(leafCount > 0);
    assert.equal(openedLeaves(new Float64Array(0), new Float64Array(0)).length, 0);
    runner.close();
  });
});
