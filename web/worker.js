// Runs the simulation off the main thread: the threaded build joins its
// workers with a blocking wait, which a page's main thread may not do.
//
// Out: "loaded" with the build and its thread limit once the module is
// ready, "ready" once a simulation exists, one "frame" per request, and
// "failed" with a message for any error.
// In: { type: "start", settings } after "loaded", then
//   { type: "settings", settings, generation } and { type: "frame", steps, probe, wantCells }.

import { Runner } from "./runner.js";

// Longest a frame spends stepping, so the page keeps its frame rate.
const FRAME_BUDGET_MS = 12;

// Threaded builds need cross-origin isolation for shared memory.
const variant = self.crossOriginIsolated ? "threads" : "single";

let module = null;
let runner = null;
// The page's count of settings changes, echoed on frames so it can drop a
// frame that was computed before the latest change.
let generation = 0;

function fail(error) {
  postMessage({ type: "failed", message: String(error?.message ?? error) });
}

async function load() {
  const { default: createModule } = await import(`./wasm/${variant}/nbody.js`);
  module = await createModule();
  postMessage({ type: "loaded", variant, maxThreads: module.MAX_THREADS });
}

onmessage = ({ data }) => {
  try {
    if (data.type === "start") {
      runner = new Runner(module, data.settings);
      postMessage({ type: "ready" });
    } else if (data.type === "settings") {
      generation = data.generation;
      runner.change(data.settings);
    } else if (data.type === "frame") {
      const { message, transfer } = runner.frame({ ...data, budgetMs: FRAME_BUDGET_MS });
      postMessage({ ...message, generation }, transfer);
    }
  } catch (error) {
    fail(error);
  }
};

load().catch(fail);
