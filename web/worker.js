// Runs the simulation off the main thread: the threaded build joins its
// workers with a blocking wait, which a page's main thread may not do.

const PARTICLE_COUNT = 8192;
const SEED = 1;
const THETA = 0.5;
const TIMESTEP = 1 / 128;
const STEPS = 16;
const STEPS_PER_CALL = 4;

// Threaded builds need cross-origin isolation for shared memory.
const variant = self.crossOriginIsolated ? "threads" : "single";

async function run() {
  const { default: createModule } = await import(`./wasm/${variant}/nbody.js`);
  const module = await createModule();
  const threads = Math.min(module.MAX_THREADS, navigator.hardwareConcurrency || 1);
  postMessage({ type: "ready", variant, threads, count: PARTICLE_COUNT });

  const softening = 4 / Math.sqrt(PARTICLE_COUNT);
  const simulation = module.Simulation.create(
    "plummer", PARTICLE_COUNT, SEED, "tree", THETA, softening, TIMESTEP, threads);
  const start = performance.now();
  for (let taken = 0; taken < STEPS; taken += STEPS_PER_CALL) {
    simulation.step(STEPS_PER_CALL);
  }
  const elapsedMs = performance.now() - start;
  const initial = simulation.initialEnergy();
  const drift = Math.abs(simulation.energy() - initial) / Math.abs(initial);
  postMessage({ type: "done", steps: STEPS, stepMs: elapsedMs / STEPS, drift });
  simulation.delete();
  if (module.PThread) {
    module.PThread.terminateAllThreads();
  }
}

run().catch((error) => postMessage({ type: "failed", message: String(error?.message ?? error) }));
