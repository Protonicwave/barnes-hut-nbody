// The simulator page: controls, the viewport, the live measurements and the
// results figures. The simulation itself runs in worker.js, which this file
// asks for one frame at a time.

import { drawEnergy, drawFigures, formatInteger, formatMilliseconds, scientific } from "./charts.js";
import {
  PARTICLE_COUNTS,
  changeKind,
  controlState,
  initialSettings,
  labels,
  moduleState,
  withChange,
} from "./settings.js";
import { Viewport } from "./viewport.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// Samples kept for the energy strip and positions kept for a binary's trails.
const MAX_ENERGY_SAMPLES = 900;
const MAX_TRAIL_POINTS = 160;
const MAX_TRAILED_PARTICLES = 8;
// Frames between updates of the read-outs and the energy strip while running.
const READOUT_INTERVAL_FRAMES = 6;
const COPIED_MESSAGE_MS = 1600;

const SETUP_HINTS = {
  plummer: "Virial units, G = M = 1. A cluster in equilibrium.",
  collapse: "A uniform sphere at rest. A stress case: energy error is hard to judge.",
  kepler: "Eccentricity 0.5, semi-major axis 1. No tree needed, it checks the integrator.",
};

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const viewport = new Viewport($("#view"));
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

let status = "loading";
let variant = null;
let settings = initialSettings(1, 1);
let generation = 0;
const view = { running: !reducedMotion, speed: 4, showCells: true };

let latest = null;
let cells = null;
let measurement = null;
let samples = [];
let seriesId = null;
let trails = [];
let probeIndex = -1;
let awaitingFrame = false;
let needsFrame = true;
let framesSinceReadout = 0;

function setText(selector, text) {
  $(selector).textContent = text;
}

// ---------------------------------------------------------------- controls

function syncControls() {
  const text = labels(settings);
  const controls = controlState(settings);
  const module = moduleState(status, variant, settings.threads);

  $("#setup").value = settings.setup;
  $("#nIdx").value = String(settings.countIndex);
  $("#nIdx").disabled = controls.countDisabled;
  setText("#nOut", text.count);
  setText("#nHint", controls.countDisabled ? "Two bodies, fixed." : `${PARTICLE_COUNTS[0]} to ${formatInteger(PARTICLE_COUNTS.at(-1))} in this tab.`);
  setText("#setupHint", SETUP_HINTS[settings.setup]);

  $$('input[name="method"]').forEach((radio) => (radio.checked = radio.value === settings.method));
  $("#theta").value = String(settings.theta);
  $("#theta").disabled = controls.thetaDisabled;
  setText("#thetaOut", text.theta);
  const hint = $("#thetaHint");
  hint.dataset.warn = String(controls.thetaWarning);
  hint.textContent = controls.thetaDisabled
    ? "Direct summation has no opening angle."
    : controls.thetaWarning ? "Not recommended above about 0.7." : "Default 0.5. Smaller is more accurate and slower.";
  $$('input[name="eps"]').forEach((radio) => {
    radio.checked = Number(radio.value) === settings.softeningScale;
    radio.disabled = controls.softeningDisabled;
  });
  setText("#epsOut", text.softening);
  $$('input[name="dt"]').forEach((radio) => (radio.checked = Number(radio.value) === settings.timestepIndex));
  $$('input[name="thr"]').forEach((radio) => {
    radio.checked = Number(radio.value) === settings.threads;
    radio.disabled = module.threadsDisabled;
  });
  $$('input[name="speed"]').forEach((radio) => (radio.checked = Number(radio.value) === view.speed));

  $("#controls").disabled = module.controlsDisabled;
  for (const id of ["#playBtn", "#resetBtn", "#seedBtn"]) {
    $(id).disabled = module.controlsDisabled;
  }
  $$('input[name="speed"]').forEach((radio) => (radio.disabled = module.controlsDisabled));
  $("#cellsToggle").hidden = controls.cellsHidden;
  $("#cellsToggle").setAttribute("aria-pressed", String(view.showCells));
  setText("#playBtn", view.running ? "Pause" : "Play");
  setText("#seedNote", text.seed);

  $("#stateLoading").dataset.show = String(module.showLoading);
  $("#stateFailed").dataset.show = String(module.showFailed);
  $("#reloadBtn").hidden = !module.showReload;
  $("#fallbackBanner").dataset.show = String(module.showBanner);
  setText("#modeBadge", module.badge);
  $("#liveDot").dataset.live = status === "ready" && view.running ? "on" : "off";
}

function change(key, value) {
  const next = withChange(settings, key, value);
  const kind = changeKind(settings, next);
  settings = next;
  if (kind === "none") {
    return;
  }
  generation += 1;
  worker.postMessage({ type: "settings", settings, generation });
  if (kind === "restart") {
    latest = null;
    cells = null;
    probeIndex = -1;
    trails = [];
    showProbe(null);
    viewport.setup(settings.setup);
    fitViewport();
  }
  measurement = null;
  showMeasurement();
  needsFrame = true;
  syncControls();
}

function wireControls() {
  $("#setup").addEventListener("change", (event) => change("setup", event.target.value));
  $("#nIdx").addEventListener("input", (event) => change("countIndex", Number(event.target.value)));
  $("#theta").addEventListener("input", (event) => change("theta", Number(event.target.value)));
  const radios = [["method", "method", String], ["eps", "softeningScale", Number], ["dt", "timestepIndex", Number], ["thr", "threads", Number]];
  for (const [name, key, convert] of radios) {
    $$(`input[name="${name}"]`).forEach((radio) =>
      radio.addEventListener("change", (event) => change(key, convert(event.target.value))));
  }
  $$('input[name="speed"]').forEach((radio) =>
    radio.addEventListener("change", (event) => { view.speed = Number(event.target.value); }));
  $("#playBtn").addEventListener("click", () => {
    view.running = !view.running;
    needsFrame = true;
    syncControls();
  });
  $("#resetBtn").addEventListener("click", () => change("run", settings.run + 1));
  $("#seedBtn").addEventListener("click", () => change("seed", settings.seed + 1));
  $("#cellsToggle").addEventListener("click", () => {
    view.showCells = !view.showCells;
    needsFrame = true;
    syncControls();
  });
  $("#reloadBtn").addEventListener("click", () => location.reload());
  $$(".copy").forEach((button) => button.addEventListener("click", () => copyCode(button)));
}

async function copyCode(button) {
  try {
    await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, COPIED_MESSAGE_MS);
  } catch {
    button.textContent = "Select and copy";
  }
}

// ---------------------------------------------------------------- viewport

function fitViewport() {
  viewport.fit();
  $("#scaleBar").style.width = `${viewport.scale}px`;
}

function wireViewport() {
  const canvas = $("#view");
  const pick = (event) => {
    if (settings.setup === "kepler" || !latest) {
      return;
    }
    probeIndex = viewport.pick(latest.positions, event.clientX, event.clientY);
    needsFrame = true;
    if (probeIndex < 0) {
      showProbe(null);
    }
  };
  canvas.addEventListener("pointermove", (event) => { if (event.pointerType === "mouse") { pick(event); } });
  canvas.addEventListener("pointerdown", pick);
  canvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") {
      probeIndex = -1;
      showProbe(null);
      needsFrame = true;
    }
  });
}

function showProbe(probe) {
  const hud = $("#probeHud");
  if (!probe || !latest) {
    hud.innerHTML = '<span class="dim">Hover or tap a particle to see its tree walk.</span>';
    return;
  }
  hud.innerHTML = `Particle ${formatInteger(probe.index + 1)}: <b class="num">${formatInteger(probe.interactions)}</b> interactions<br>` +
    `<span class="dim">direct summation uses ${formatInteger(latest.count - 1)}</span>`;
}

function draw() {
  viewport.draw({
    positions: latest?.positions,
    bands: latest?.bands,
    cells,
    probe: latest?.probe,
    trails,
    showCells: view.showCells,
  });
}

// --------------------------------------------------------------- read-outs

function showMeasurement() {
  const ready = measurement && latest && measurement.count === latest.count;
  if (!ready) {
    for (const id of ["#tDirect", "#tTree", "#speedup", "#errMed", "#errP99", "#inter", "#interDirect"]) {
      setText(id, "…");
    }
    return;
  }
  const speedup = measurement.directMs / measurement.treeMs;
  setText("#tDirect", formatMilliseconds(measurement.directMs));
  setText("#tTree", formatMilliseconds(measurement.treeMs));
  setText("#speedup", `${speedup >= 10 ? speedup.toFixed(0) : speedup.toFixed(1)}×`);
  $('#timeBars .bar-row[data-kind="tree"] .fill').style.width = `${Math.max(1.5, 100 / speedup)}%`;
  setText("#errMed", scientific(measurement.medianError));
  setText("#errP99", scientific(measurement.p99Error));
  setText("#inter", formatInteger(measurement.meanInteractions));
  setText("#interDirect", formatInteger(measurement.count - 1));
}

function showReadouts() {
  setText("#timeVal", latest.time.toFixed(2));
  const last = samples.at(-1);
  setText("#eNow", last ? scientific(last[1]) : "0");
  showMeasurement();
  drawEnergy($("#energySvg"), samples, latest.time, settings.method);
}

function keepTrails(message) {
  if (message.count > MAX_TRAILED_PARTICLES) {
    trails = [];
    return;
  }
  if (trails.length === 0) {
    trails = Array.from({ length: message.count }, () => []);
  }
  trails.forEach((trail, body) => {
    trail.push([message.positions[2 * body], message.positions[2 * body + 1]]);
    if (trail.length > MAX_TRAIL_POINTS) {
      trail.shift();
    }
  });
}

function receiveFrame(message) {
  awaitingFrame = false;
  if (message.generation !== generation) {
    return;
  }
  if (message.seriesId !== seriesId) {
    seriesId = message.seriesId;
    samples = [];
  }
  samples.push(...message.samples);
  samples.splice(0, Math.max(0, samples.length - MAX_ENERGY_SAMPLES));
  cells = message.cells ?? cells;
  const stepped = !latest || message.time !== latest.time;
  latest = message;
  if (stepped && view.running) {
    keepTrails(message);
  }
  if (message.measurement) {
    measurement = message.measurement;
  }
  showProbe(message.probe);
  draw();
  framesSinceReadout += 1;
  if (framesSinceReadout >= READOUT_INTERVAL_FRAMES || !view.running || message.measurement) {
    framesSinceReadout = 0;
    showReadouts();
  }
}

// ------------------------------------------------------------------ worker

function fail(message) {
  status = "failed";
  setText("#failedDetail", message ?? "");
  syncControls();
}

worker.onmessage = ({ data }) => {
  if (data.type === "loaded") {
    variant = data.variant;
    settings = initialSettings(data.maxThreads, navigator.hardwareConcurrency);
    viewport.setup(settings.setup);
    worker.postMessage({ type: "start", settings });
  } else if (data.type === "ready") {
    status = "ready";
    syncControls();
    fitViewport();
  } else if (data.type === "frame") {
    receiveFrame(data);
  } else if (data.type === "failed") {
    fail(data.message);
  }
};
worker.onerror = (event) => fail(event.message);
worker.onmessageerror = () => fail("The worker sent a message the page could not read.");

function requestFrames() {
  requestAnimationFrame(requestFrames);
  if (status !== "ready" || awaitingFrame || !(view.running || needsFrame)) {
    return;
  }
  awaitingFrame = true;
  needsFrame = false;
  worker.postMessage({
    type: "frame",
    steps: view.running ? view.speed : 0,
    probe: probeIndex,
    wantCells: view.showCells,
  });
}

// ----------------------------------------------------------------- results

async function loadFigures() {
  try {
    const response = await fetch("data/results.json");
    if (!response.ok) {
      throw new Error(`results.json returned ${response.status}`);
    }
    const data = await response.json();
    const redraw = () => drawFigures(data);
    redraw();
    return redraw;
  } catch (error) {
    setText("#capTime", `The measured results did not load: ${error.message}. Reload the page to try again.`);
    return () => {};
  }
}

function watchNavigation() {
  const links = $$(".site-head nav a");
  for (const link of links) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        links.forEach((other) => other.setAttribute("aria-current", String(other === link)));
      }
    }, { rootMargin: "-45% 0px -50% 0px" });
    observer.observe($(link.getAttribute("href")));
  }
}

async function start() {
  wireControls();
  wireViewport();
  watchNavigation();
  syncControls();
  fitViewport();
  const redrawFigures = await loadFigures();
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width === lastWidth) {
      return;
    }
    lastWidth = width;
    fitViewport();
    redrawFigures();
    if (latest) {
      draw();
      showReadouts();
    }
  }).observe($(".wrap"));
  requestAnimationFrame(requestFrames);
}

start();
