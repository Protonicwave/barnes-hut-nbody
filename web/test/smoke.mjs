// Loads both WebAssembly builds under Node and drives them through Embind.
// Build them first: cmake --workflow --preset wasm-threads, then wasm-single.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

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
      const counted = trace.accepted.length / 5 + trace.particles.length;
      assert.ok(counted > 0 && counted < COUNT - 1);
      assert.ok(trace.opened.length > 0);
      assert.ok(!trace.particles.includes(3));
      assert.throws(() => simulation.walkTrace(COUNT), new RegExp(`index.*got ${COUNT}`));
      assert.throws(() => simulation.walkTrace(-1), /index.*got -1/);
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
