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

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const JAVASCRIPT_BUDGET_KIB = 75;
const DRAW_BUDGET_MS = 4;
const LCP_BUDGET_MS = 2500;
const CLS_BUDGET = 0.1;
const OVERALL_TIMEOUT_MS = 120_000;
const SETTLE_AFTER_LOAD_MS = 2500;

const PHONE = { width: 375, height: 812, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1200, height: 900, deviceScaleFactor: 2, mobile: false };

const WEB_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".wasm", "application/wasm"],
  [".woff2", "font/woff2"],
]);

function chromePath(argv) {
  const at = argv.indexOf("--chrome");
  const value = at >= 0 ? argv[at + 1] : undefined;
  if (!value || argv.length !== 2) {
    throw new Error('usage: node web/test/page_budget.mjs --chrome "<path to chrome>"');
  }
  return value;
}

// Serves web/ on a free local port, GET only, with no isolation headers so
// the page loads the single-threaded build.
function serveWeb() {
  const server = createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = path.join(WEB_DIRECTORY, requested === "/" ? "index.html" : requested);
    if (path.relative(WEB_DIRECTORY, file).startsWith("..")) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": CONTENT_TYPES.get(path.extname(file)) ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function javascriptKiB() {
  const names = (await readdir(WEB_DIRECTORY)).filter((name) => name.endsWith(".js"));
  const sizes = await Promise.all(
    names.map(async (name) => gzipSync(await readFile(path.join(WEB_DIRECTORY, name)), { level: 9 }).length));
  return sizes.reduce((sum, size) => sum + size, 0) / 1024;
}

// The DevTools protocol over the pipe Chrome reads on descriptor 3 and writes
// on descriptor 4, one JSON message per NUL-terminated chunk.
class Devtools {
  #input;
  #pending = new Map();
  #nextId = 1;
  #buffer = "";

  constructor(input, output) {
    this.#input = input;
    output.setEncoding("utf8");
    output.on("data", (chunk) => this.#receive(chunk));
  }

  #receive(chunk) {
    this.#buffer += chunk;
    const messages = this.#buffer.split("\0");
    this.#buffer = messages.pop();
    for (const text of messages) {
      const message = JSON.parse(text);
      const waiting = this.#pending.get(message.id);
      if (!waiting) {
        continue;
      }
      this.#pending.delete(message.id);
      if (message.error) {
        waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      } else {
        waiting.resolve(message.result);
      }
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }
}

async function evaluate(devtools, sessionId, expression) {
  const { result, exceptionDetails } = await devtools.send(
    "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) {
    throw new Error(`page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  }
  return result.value;
}

const POLL_INTERVAL_MS = 100;

// Polls an expression until it is truthy and returns its value. Polling from
// here, rather than awaiting a promise in the page, survives the navigation
// replacing the page that was current when the call was made.
async function waitFor(devtools, sessionId, expression) {
  for (;;) {
    const value = await evaluate(devtools, sessionId, expression);
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function drawMedianMs(devtools, sessionId, origin) {
  await devtools.send("Emulation.setDeviceMetricsOverride", DESKTOP, sessionId);
  await devtools.send("Page.navigate", { url: `${origin}/test/scope_bench.html` }, sessionId);
  const result = await waitFor(devtools, sessionId,
    'location.pathname.endsWith("scope_bench.html") && window.benchResult');
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
  await waitFor(devtools, sessionId, 'location.pathname === "/index.html" && document.readyState === "complete"');
  await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_LOAD_MS));
  return evaluate(devtools, sessionId, "window.__vitals");
}

async function measure(chrome) {
  const profile = await mkdtemp(path.join(tmpdir(), "page-budget-"));
  const server = await serveWeb();
  const browser = spawn(chrome, [
    "--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const failed = new Promise((_, reject) => browser.on("error", reject).on("exit", () => reject(new Error("Chrome exited"))));
  try {
    const devtools = new Devtools(browser.stdio[3], browser.stdio[4]);
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
    browser.removeAllListeners("exit");
    browser.kill();
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
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
