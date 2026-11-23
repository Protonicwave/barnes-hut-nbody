// Captures the running simulator for the README: the page title down to the
// foot of the viewport, paused a few seconds into a run on the threaded build,
// once in each colour scheme. Writes docs/screenshots/hero-light.png and
// hero-dark.png. Drives Chrome over a pipe, with the standard library only.
//
//   node web/test/screenshot.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
//
// Exit 0 when both files are written within their size limit, 1 when a file is
// over it, 2 on a usage error, a missing Wasm build, a page that does not reach
// the running state, or when Chrome fails.

import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { WEB_DIRECTORY, evaluate, launchChrome, serveWeb, waitFor } from "./chrome.mjs";

const SCHEMES = ["light", "dark"];
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false };
const LIVE_TIMEOUT_MS = 60_000;
const PAUSE_TIMEOUT_MS = 10_000;
const RUN_BEFORE_CAPTURE_MS = 5000;
const SETTLE_AFTER_PAUSE_MS = 500;
const OVERALL_TIMEOUT_MS = 180_000;
const MAX_FILE_KIB = 500;

const OUTPUT_DIRECTORY = path.resolve(WEB_DIRECTORY, "..", "docs", "screenshots");
const WASM_BUILDS = ["threads", "single"].map((name) => path.join(WEB_DIRECTORY, "wasm", name, "nbody.wasm"));

class UsageError extends Error {}

function chromePath(argv) {
  const at = argv.indexOf("--chrome");
  const value = at >= 0 ? argv[at + 1] : undefined;
  if (!value || argv.length !== 2) {
    throw new UsageError('usage: node web/test/screenshot.mjs --chrome "<path to chrome>"');
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

// The full-width band from the top of the header to the foot of the
// instrument, in page coordinates.
const CLIP_SCRIPT = `(() => {
  const top = document.querySelector(".site-head").getBoundingClientRect();
  const foot = document.querySelector("#simulator").getBoundingClientRect();
  return { x: 0, y: top.top + scrollY, width: document.documentElement.clientWidth, height: foot.bottom - top.top };
})()`;

async function capture(devtools, sessionId, origin, scheme) {
  await devtools.send("Emulation.setDeviceMetricsOverride", VIEWPORT, sessionId);
  await devtools.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: scheme },
      { name: "prefers-reduced-motion", value: "no-preference" },
    ],
  }, sessionId);
  await devtools.send("Page.navigate", { url: `${origin}/index.html` }, sessionId);
  try {
    await waitFor(devtools, sessionId, 'document.querySelector("#liveDot")?.dataset.live === "on"', LIVE_TIMEOUT_MS);
  } catch (error) {
    const badge = await evaluate(devtools, sessionId, 'document.querySelector("#modeBadge")?.textContent');
    throw new Error(`${scheme}: the page did not start running (badge: ${badge}): ${error.message}`);
  }
  const fallback = await evaluate(devtools, sessionId, 'document.querySelector("#fallbackBanner").dataset.show');
  if (fallback === "true") {
    throw new Error(`${scheme}: the page loaded the single-threaded build, so it is not cross-origin isolated`);
  }
  await sleep(RUN_BEFORE_CAPTURE_MS);
  await evaluate(devtools, sessionId, 'document.querySelector("#playBtn").click()');
  await waitFor(devtools, sessionId, 'document.querySelector("#playBtn").textContent === "Play"', PAUSE_TIMEOUT_MS);
  await sleep(SETTLE_AFTER_PAUSE_MS);
  const clip = await evaluate(devtools, sessionId, CLIP_SCRIPT);
  const { data } = await devtools.send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 },
  }, sessionId);
  return Buffer.from(data, "base64");
}

async function captureAll(chrome) {
  await requireWasmBuilds();
  const server = await serveWeb({ isolated: true });
  const { devtools, failed, close } = await launchChrome(chrome);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const run = async () => {
      const files = [];
      for (const scheme of SCHEMES) {
        const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
        const file = path.join(OUTPUT_DIRECTORY, `hero-${scheme}.png`);
        await mkdir(OUTPUT_DIRECTORY, { recursive: true });
        await writeFile(file, await capture(devtools, sessionId, origin, scheme));
        await devtools.send("Target.closeTarget", { targetId });
        files.push(file);
      }
      return files;
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
  let files;
  try {
    files = await captureAll(chrome);
  } finally {
    clearTimeout(timer);
  }
  let withinLimit = true;
  for (const file of files) {
    const kib = (await stat(file)).size / 1024;
    const within = kib <= MAX_FILE_KIB;
    withinLimit &&= within;
    console.log(`${path.relative(process.cwd(), file)} ${kib.toFixed(1)} KiB  limit ${MAX_FILE_KIB} KiB  ${within ? "ok" : "OVER"}`);
  }
  process.exitCode = withinLimit ? 0 : 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
