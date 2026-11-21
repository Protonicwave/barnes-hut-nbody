// Measures the page against its budgets and prints each figure beside its
// budget: the size of its own JavaScript, the draw time of the viewport, and
// the largest contentful paint and layout shift on a phone-width load of the
// single-threaded build. Drives Chrome over a pipe, with the standard library
// only.
//
//   node web/test/page_budget.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
//
// Exit 0 when every figure is within budget, 1 when any is over, 2 on a usage
// error or when Chrome fails.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { WEB_DIRECTORY, evaluate, launchChrome, serveWeb, waitFor } from "./chrome.mjs";

const JAVASCRIPT_BUDGET_KIB = 75;
const DRAW_BUDGET_MS = 4;
const LCP_BUDGET_MS = 2500;
const CLS_BUDGET = 0.1;
const OVERALL_TIMEOUT_MS = 120_000;
const SETTLE_AFTER_LOAD_MS = 2500;
const WAIT_TIMEOUT_MS = 60_000;

const PHONE = { width: 375, height: 812, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1200, height: 900, deviceScaleFactor: 2, mobile: false };

function chromePath(argv) {
  const at = argv.indexOf("--chrome");
  const value = at >= 0 ? argv[at + 1] : undefined;
  if (!value || argv.length !== 2) {
    throw new Error('usage: node web/test/page_budget.mjs --chrome "<path to chrome>"');
  }
  return value;
}

async function javascriptKiB() {
  const names = (await readdir(WEB_DIRECTORY)).filter((name) => name.endsWith(".js"));
  const sizes = await Promise.all(
    names.map(async (name) => gzipSync(await readFile(path.join(WEB_DIRECTORY, name)), { level: 9 }).length));
  return sizes.reduce((sum, size) => sum + size, 0) / 1024;
}

async function drawMedianMs(devtools, sessionId, origin) {
  await devtools.send("Emulation.setDeviceMetricsOverride", DESKTOP, sessionId);
  await devtools.send("Page.navigate", { url: `${origin}/test/scope_bench.html` }, sessionId);
  const result = await waitFor(devtools, sessionId,
    'location.pathname.endsWith("scope_bench.html") && window.benchResult', WAIT_TIMEOUT_MS);
  if (result.error) {
    throw new Error(`scope_bench.html failed: ${result.error}`);
  }
  return result.medianMs;
}

const VITALS_SCRIPT = `
  window.__vitals = { lcp: 0, cls: 0 };
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__vitals.lcp = entry.startTime; })
    .observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__vitals.cls += entry.value; })
    .observe({ type: "layout-shift", buffered: true });
`;

async function pageVitals(devtools, sessionId, origin) {
  await devtools.send("Emulation.setDeviceMetricsOverride", PHONE, sessionId);
  await devtools.send("Page.enable", {}, sessionId);
  await devtools.send("Page.addScriptToEvaluateOnNewDocument", { source: VITALS_SCRIPT }, sessionId);
  await devtools.send("Page.navigate", { url: `${origin}/index.html` }, sessionId);
  await waitFor(devtools, sessionId, 'location.pathname === "/index.html" && document.readyState === "complete"',
    WAIT_TIMEOUT_MS);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_LOAD_MS));
  return evaluate(devtools, sessionId, "window.__vitals");
}

async function measure(chrome) {
  const server = await serveWeb({ isolated: false });
  const { devtools, failed, close } = await launchChrome(chrome);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const run = async () => {
      const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
      const draw = await drawMedianMs(devtools, sessionId, origin);
      const vitals = await pageVitals(devtools, sessionId, origin);
      return { draw, ...vitals };
    };
    return await Promise.race([run(), failed]);
  } finally {
    server.close();
    await close();
  }
}

function report(rows) {
  let withinBudget = true;
  for (const [name, figure, budget, unit] of rows) {
    const within = figure <= budget;
    withinBudget &&= within;
    console.log(`${name.padEnd(28)} ${figure.toFixed(3).padStart(10)} ${unit}  budget ${budget} ${unit}  ${within ? "ok" : "OVER"}`);
  }
  return withinBudget;
}

async function main() {
  const chrome = chromePath(process.argv.slice(2));
  const timer = setTimeout(() => {
    console.error(`no result after ${OVERALL_TIMEOUT_MS / 1000} s`);
    process.exit(2);
  }, OVERALL_TIMEOUT_MS);
  let measured;
  try {
    measured = { kib: await javascriptKiB(), ...(await measure(chrome)) };
  } finally {
    clearTimeout(timer);
  }
  const { kib, draw, lcp, cls } = measured;
  const within = report([
    ["own JavaScript, gzip", kib, JAVASCRIPT_BUDGET_KIB, "KiB"],
    ["viewport draw, median", draw, DRAW_BUDGET_MS, "ms"],
    ["largest contentful paint", lcp, LCP_BUDGET_MS, "ms"],
    ["cumulative layout shift", cls, CLS_BUDGET, ""],
  ]);
  process.exitCode = within ? 0 : 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
