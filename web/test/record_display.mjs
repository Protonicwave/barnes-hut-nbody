// Records the simulator's display running a cold collapse, for the README
// animation: one PNG of the glass per step, with the simulated time read from
// the page after each. Writes build/display-frames/frame-0001.png onwards and
// frames.json, a list of { file, time }, for scripts/encode_display_clip.py to
// pick from at even simulated-time intervals.
// Drives Chrome over a pipe, with the standard library only.
//
//   node web/test/record_display.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
//
// Exit 0 when the frames are written, 2 on a usage error, a missing Wasm
// build, a page that does not reach the running state, a step count that is
// not a number, too many frames before the end time, or when Chrome fails.

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { WEB_DIRECTORY, evaluate, launchChrome, serveWeb, waitFor } from "./chrome.mjs";

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const SETUP = "collapse";
const SPEED_STEPS_PER_FRAME = "1";
// The page's default timestep, which the recording leaves as it is.
const TIMESTEP = 1 / 128;
// The uniform sphere's free-fall time with G = M = R = 1 is about 1.1, so this
// shows it at rest, the collapse and the bounce.
const CLIP_END_TIME = 3.0;
// One step of 1/128 per frame reaches the end time in 384 frames.
const MAX_FRAMES = 600;
const LIVE_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 10_000;
const SETTLE_AFTER_RESTART_MS = 500;
const RETRY_AFTER_FRAMES = 30;
const OVERALL_TIMEOUT_MS = 300_000;

const OUTPUT_DIRECTORY = path.resolve(WEB_DIRECTORY, "..", "build", "display-frames");
const WASM_BUILDS = ["threads", "single"].map((name) => path.join(WEB_DIRECTORY, "wasm", name, "nbody.wasm"));

class UsageError extends Error {}

function chromePath(argv) {
  const at = argv.indexOf("--chrome");
  const value = at >= 0 ? argv[at + 1] : undefined;
  if (!value || argv.length !== 2) {
    throw new UsageError('usage: node web/test/record_display.mjs --chrome "<path to chrome>"');
  }
  return value;
}

async function requireWasmBuilds() {
  for (const file of WASM_BUILDS) {
    try {
      await access(file);
    } catch {
      throw new UsageError(
        `missing ${path.relative(path.dirname(WEB_DIRECTORY), file)}: build both with `
        + "`cmake --workflow --preset wasm-threads` and `cmake --workflow --preset wasm-single` "
        + "after activating Emscripten (`. ~/emsdk/emsdk_env.ps1`)");
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The glass in page coordinates, scrolled into view so the capture is of what
// the compositor last drew.
const CLIP_SCRIPT = `(() => {
  const glass = document.querySelector(".glass");
  glass.scrollIntoView({ block: "center" });
  const box = glass.getBoundingClientRect();
  return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height, scale: 1 };
})()`;

// The simulated time of the drawn frame, from the step count rather than the
// clock, which shows two decimals and so repeats across steps.
async function readTime(devtools, sessionId) {
  const text = await evaluate(devtools, sessionId, 'document.querySelector("#stepValue").textContent');
  if (!/^\d{1,3}(,\d{3})*$/.test(text)) {
    throw new Error(`expected a step count in #stepValue, got ${JSON.stringify(text)}`);
  }
  return Number(text.replaceAll(",", "")) * TIMESTEP;
}

// The step rate on the glass measures how fast the recording steps the paused
// page, not how fast the simulator runs, so the recording leaves it out.
const HIDE_STEP_RATE_SCRIPT = `(() => {
  const style = document.createElement("style");
  style.textContent = ".hud span:has(> #rateValue) { visibility: hidden; }";
  document.head.append(style);
})()`;

// Loads the page, pauses it, and restarts on the cold collapse at one step per
// frame, so the first capture is the sphere at rest.
async function prepare(devtools, sessionId, origin) {
  await devtools.send("Emulation.setDeviceMetricsOverride", VIEWPORT, sessionId);
  await devtools.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "dark" },
      { name: "prefers-reduced-motion", value: "no-preference" },
    ],
  }, sessionId);
  await devtools.send("Page.navigate", { url: `${origin}/index.html` }, sessionId);
  try {
    await waitFor(devtools, sessionId, 'document.querySelector("#liveDot")?.dataset.live === "on"', LIVE_TIMEOUT_MS);
  } catch (error) {
    const badge = await evaluate(devtools, sessionId, 'document.querySelector("#modeBadge")?.textContent');
    throw new Error(`the page did not start running (badge: ${badge}): ${error.message}`);
  }
  const fallback = await evaluate(devtools, sessionId, 'document.querySelector("#fallbackBanner").dataset.show');
  if (fallback === "true") {
    throw new Error("the page loaded the single-threaded build, so it is not cross-origin isolated");
  }
  await evaluate(devtools, sessionId, 'document.querySelector("#playBtn").click()');
  await waitFor(devtools, sessionId, 'document.querySelector("#playBtn").textContent === "Play"', CONTROL_TIMEOUT_MS);
  await evaluate(devtools, sessionId, `(() => {
    document.querySelector('input[name="speed"][value="${SPEED_STEPS_PER_FRAME}"]').click();
    const setup = document.querySelector("#setup");
    setup.value = "${SETUP}";
    setup.dispatchEvent(new Event("change"));
  })()`);
  await waitFor(devtools, sessionId, 'document.querySelector("#stepValue").textContent === "0"', CONTROL_TIMEOUT_MS);
  await evaluate(devtools, sessionId, HIDE_STEP_RATE_SCRIPT);
  await sleep(SETTLE_AFTER_RESTART_MS);
}

// Plays the paused page for one animation frame, so it asks the worker for one
// step, then waits until the step count shows it. The paused page updates its
// readouts on every frame, where the running page does so every few frames,
// so the time read with each capture matches its pixels. A capture takes
// longer than a step, so stepping between captures keeps the frames as close
// in simulated time as one step. When the play frame found a request still in
// flight, nothing was asked for, so after a wait it plays another frame.
const ADVANCE_SCRIPT = `new Promise((resolve, reject) => {
  const stepCount = document.querySelector("#stepValue");
  const play = document.querySelector("#playBtn");
  const before = stepCount.textContent;
  const deadline = performance.now() + ${CONTROL_TIMEOUT_MS};
  let framesWaited = 0;
  const watch = () => {
    if (stepCount.textContent !== before) {
      resolve();
    } else if (performance.now() > deadline) {
      reject(new Error("the step count stayed at " + before));
    } else if (++framesWaited > ${RETRY_AFTER_FRAMES}) {
      playOneFrame();
    } else {
      requestAnimationFrame(watch);
    }
  };
  const playOneFrame = () => {
    framesWaited = 0;
    play.click();
    requestAnimationFrame(() => {
      play.click();
      requestAnimationFrame(watch);
    });
  };
  playOneFrame();
})`;

// Captures the glass and reads its time, one step at a time, until the time
// reaches the end time.
async function recordFrames(devtools, sessionId) {
  const clip = await evaluate(devtools, sessionId, CLIP_SCRIPT);
  const frames = [];
  const capture = async () => {
    const { data } = await devtools.send("Page.captureScreenshot", { format: "png", clip }, sessionId);
    frames.push({ png: Buffer.from(data, "base64"), time: await readTime(devtools, sessionId) });
  };
  await capture();
  while (frames.at(-1).time < CLIP_END_TIME) {
    if (frames.length >= MAX_FRAMES) {
      throw new Error(`reached ${MAX_FRAMES} frames at t = ${frames.at(-1).time}, before t = ${CLIP_END_TIME}`);
    }
    await evaluate(devtools, sessionId, ADVANCE_SCRIPT);
    await capture();
  }
  return frames;
}

async function writeFrames(frames) {
  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const manifest = frames.map(({ time }, index) => ({ file: `frame-${String(index + 1).padStart(4, "0")}.png`, time }));
  await Promise.all(frames.map(({ png }, index) => writeFile(path.join(OUTPUT_DIRECTORY, manifest[index].file), png)));
  await writeFile(path.join(OUTPUT_DIRECTORY, "frames.json"), `${JSON.stringify(manifest, null, 1)}\n`);
}

async function record(chrome) {
  await requireWasmBuilds();
  const server = await serveWeb({ isolated: true });
  const { devtools, failed, close } = await launchChrome(chrome);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const run = async () => {
      const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
      await prepare(devtools, sessionId, origin);
      return recordFrames(devtools, sessionId);
    };
    return await Promise.race([run(), failed]);
  } finally {
    server.close();
    await close();
  }
}

async function main() {
  const chrome = chromePath(process.argv.slice(2));
  const timer = setTimeout(() => {
    console.error(`no result after ${OVERALL_TIMEOUT_MS / 1000} s`);
    process.exit(2);
  }, OVERALL_TIMEOUT_MS);
  let frames;
  try {
    frames = await record(chrome);
  } finally {
    clearTimeout(timer);
  }
  await writeFrames(frames);
  console.log(`${frames.length} frames to t = ${frames.at(-1).time.toFixed(2)} in ${path.relative(process.cwd(), OUTPUT_DIRECTORY)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
