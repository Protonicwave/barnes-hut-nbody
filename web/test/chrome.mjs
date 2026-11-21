// What the page scripts in this directory share: a static server for web/, a
// headless Chrome driven over a pipe, and two helpers for running code in the
// page. Standard library only.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const POLL_INTERVAL_MS = 100;
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".wasm", "application/wasm"],
  [".woff2", "font/woff2"],
]);
const ISOLATION_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

// Serves web/ on a free local port, GET only. With `isolated` it sends the two
// headers that make the page cross-origin isolated, so it loads the threaded
// build; without, the page falls back to the single-threaded one.
export function serveWeb({ isolated }) {
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
      response.writeHead(200, {
        "content-type": CONTENT_TYPES.get(path.extname(file)) ?? "application/octet-stream",
        ...(isolated ? ISOLATION_HEADERS : {}),
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
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

// Starts headless Chrome with a throwaway profile. `failed` rejects if Chrome
// exits or cannot start, so a caller races its work against it; `close` stops
// Chrome and removes the profile.
export async function launchChrome(chromePath) {
  const profile = await mkdtemp(path.join(tmpdir(), "chrome-profile-"));
  const browser = spawn(chromePath, [
    "--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const failed = new Promise((_, reject) => browser.on("error", reject).on("exit", () => reject(new Error("Chrome exited"))));
  // Rejection is delivered through the caller's race; this keeps it from
  // surfacing as unhandled when the caller never races.
  failed.catch(() => {});
  return {
    devtools: new Devtools(browser.stdio[3], browser.stdio[4]),
    failed,
    async close() {
      browser.removeAllListeners("exit");
      browser.kill();
      await rm(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

export async function evaluate(devtools, sessionId, expression) {
  const { result, exceptionDetails } = await devtools.send(
    "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) {
    throw new Error(`page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  }
  return result.value;
}

// Polls an expression until it is truthy and returns its value, or throws once
// `timeoutMs` has passed. Polling from here, rather than awaiting a promise in
// the page, survives a navigation replacing the page that was current when the
// call was made.
export async function waitFor(devtools, sessionId, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate(devtools, sessionId, expression);
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${expression}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
