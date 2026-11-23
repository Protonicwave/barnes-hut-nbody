// The simulator page: controls, the viewport, the live measurements and the
// results figures. The simulation itself runs in worker.js, which this file
// asks for one frame at a time.

import { decadeFraction, drawEnergy, drawFigures, formatInteger, formatMilliseconds, scientific } from "./charts.js";
import {
  PARTICLE_COUNTS,
  changeKind,
  controlState,
  effectiveMethod,
  initialSettings,
  labels,
  moduleState,
  stepsTaken,
  withChange,
} from "./settings.js";
import { runRecord } from "./record.js";
import { defaultMarkedParticle, testText, walkCounts } from "./scope.js";
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
// The conservation meters share one log scale, 1e-6 to 1e-1.
const METER_LOW_DECADE = -6;
const METER_HIGH_DECADE = -1;
const METERS = [
  { key: "energy", value: "#mEnergy", track: "#trEnergy" },
  { key: "momentum", value: "#mMomentum", track: "#trMomentum" },
  { key: "centre", value: "#mCentre", track: "#trCentre" },
];
const NO_CONSERVATION = { energy: 0, momentum: 0, centre: 0 };

const SETUP_HINTS = {
  plummer: "Virial units, G = M = 1. A cluster in equilibrium.",
  collapse: "A uniform sphere at rest. A stress case: energy error is hard to judge.",
  kepler: "Eccentricity 0.5, semi-major axis 1. No tree needed, it checks the integrator.",
};

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const viewport = new Viewport(
  { graticule: $("#graticule"), particles: $("#particles"), overlay: $("#view") },
  { persistence: !reducedMotion });
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

let status = "loading";
let variant = null;
let settings = initialSettings(1, 1);
let generation = 0;
const view = { running: !reducedMotion, speed: 4, showCells: false };

let latest = null;
let cells = null;
let measurement = null;
let samples = [];
let seriesId = null;
let trails = [];
// The marked particle: the one under the pointer, else the default picked on
// the first frame after a restart.
let hoverIndex = -1;
let defaultMark = -1;
let captionText = "";
let awaitingFrame = false;
let needsFrame = true;
let framesSinceReadout = 0;

function setText(selector, text) {
  $(selector).textContent = text;
}

// Controls

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

  $$('input[name="method"]').forEach((radio) => {
    radio.checked = radio.value === effectiveMethod(settings);
    radio.disabled = controls.methodDisabled;
  });
  $("#theta").value = String(settings.theta);
  $("#theta").disabled = controls.thetaDisabled;
  setText("#thetaOut", text.theta);
  const hint = $("#thetaHint");
  hint.dataset.warn = String(controls.thetaWarning);
  hint.textContent = controls.thetaDisabled
    ? "Direct summation has no opening angle."
    : controls.thetaWarning ? "Not recommended above about 0.7." : "Default 0.5. Smaller is more accurate and slower.";
  $$('input[name="eps"]').forEach((radio) => {
    radio.checked = !controls.softeningDisabled && Number(radio.value) === settings.softeningScale;
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
  for (const id of ["#playBtn", "#resetBtn"]) {
    $(id).disabled = module.controlsDisabled;
  }
  $("#seedBtn").disabled = module.controlsDisabled || controls.seedDisabled;
  $$('input[name="speed"]').forEach((radio) => (radio.disabled = module.controlsDisabled));
  $("#cellsToggle").hidden = controls.cellsHidden;
  $("#cellsToggle").disabled = controls.cellsDisabled || module.controlsDisabled;
  $("#cellsToggle").setAttribute("aria-pressed", String(view.showCells));
  setText("#playBtn", view.running ? "Pause" : "Play");
  $("#seedNote").hidden = controls.seedDisabled;
  setText("#seedNote", text.seed);
  const glassSettings = [`ε ${text.softening}`, `Δt ${text.timestep}`];
  if (!controls.thetaDisabled && settings.setup !== "kepler") {
    glassSettings.unshift(`θ ${text.theta}`);
  }
  // The glass keeps runs of spaces (white-space: pre) to space the readings.
  setText("#glassSettings", glassSettings.join("   "));
  showRecord();

  $("#simulator").dataset.module = status;
  $("#stateLoading").dataset.show = String(module.showLoading);
  $("#stateFailed").dataset.show = String(module.showFailed);
  $("#reloadBtn").hidden = !module.showFailed;
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
    hoverIndex = -1;
    defaultMark = -1;
    trails = [];
    viewport.setup(settings.setup);
    fitViewport();
  }
  measurement = null;
  showMeasurement();
  showMeters();
  showCaption();
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

// Viewport

function fitViewport() {
  viewport.fit();
  $("#scaleBar").style.width = `${viewport.scale}px`;
}

function markedParticle() {
  return hoverIndex >= 0 ? hoverIndex : defaultMark;
}

function wireViewport() {
  const canvas = $("#view");
  const pick = (event) => {
    if (settings.setup === "kepler" || !latest) {
      return;
    }
    const picked = viewport.pick(latest.positions, event.clientX, event.clientY);
    if (picked >= 0 && picked !== hoverIndex) {
      hoverIndex = picked;
      needsFrame = true;
    }
  };
  canvas.addEventListener("pointermove", (event) => { if (event.pointerType === "mouse") { pick(event); } });
  canvas.addEventListener("pointerdown", pick);
  canvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") {
      hoverIndex = -1;
      needsFrame = true;
    }
  });
}

// What the force on the marked particle was summed from, written on the glass.
function showCaption() {
  const counts = latest && walkCounts(latest.probe, latest.count, settings.setup, settings.method);
  let text;
  if (settings.setup === "kepler") {
    text = "Two bodies, no tree";
  } else if (counts && settings.method === "direct") {
    text = `Marked particle: ${formatInteger(counts.particles)} particles, one by one`;
  } else if (counts) {
    text = `Marked particle: ${formatInteger(counts.cells)} cells + ${formatInteger(counts.particles)} particles`;
    if (latest.probe.test) {
      text += `
${testText(latest.probe.test)}`;
    }
  } else {
    return;
  }
  if (text !== captionText) {
    captionText = text;
    setText("#scopeCaption", text);
  }
}

// stepped: whether the particles moved since the last draw.
function draw(stepped = false) {
  viewport.draw({
    positions: latest?.positions,
    bands: latest?.bands,
    stepped,
    mark: markedParticle(),
    probe: latest?.probe,
    cells,
    trails,
    showCells: view.showCells && settings.method === "tree",
  });
}

// Read outs

const MEASUREMENT_PARTS = ["#timeBars", "#speedupRow", "#measurePairs", "#measureFine"];

function showMeasurement() {
  const none = settings.setup === "kepler";
  $("#measureNone").hidden = !none;
  MEASUREMENT_PARTS.forEach((id) => ($(id).hidden = none));
  if (none) {
    return;
  }
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

function showRecord() {
  setText("#record", runRecord(settings, latest?.time ?? 0, latest?.forceChangedAt ?? null));
}

function showMeters() {
  const conservation = latest?.conservation ?? NO_CONSERVATION;
  for (const { key, value, track } of METERS) {
    setText(value, scientific(conservation[key]));
    $(track).style.setProperty("--w", `${100 * decadeFraction(conservation[key], METER_LOW_DECADE, METER_HIGH_DECADE)}%`);
  }
}

// Achieved steps per second: the steps taken over the last RATE_WINDOW_MS of
// running frames. Pausing or a restart starts the window again.
const RATE_WINDOW_MS = 1000;
let rateSamples = [];

function stepRate(steps, now) {
  if (!view.running || rateSamples.length > 0 && steps < rateSamples.at(-1).steps) {
    rateSamples = [];
  }
  if (!view.running) {
    return null;
  }
  rateSamples.push({ steps, now });
  while (rateSamples.length > 1 && now - rateSamples[0].now > RATE_WINDOW_MS) {
    rateSamples.shift();
  }
  const first = rateSamples[0];
  return now > first.now ? (steps - first.steps) / ((now - first.now) / 1000) : null;
}

function showReadouts() {
  showRecord();
  showMeters();
  setText("#clockValue", latest.time.toFixed(2));
  const steps = stepsTaken(settings, latest.time);
  setText("#stepValue", formatInteger(steps));
  const rate = stepRate(steps, performance.now());
  setText("#rateValue", rate === null ? "0" : formatInteger(Math.round(rate)));
  const last = samples.at(-1);
  setText("#eNow", last ? scientific(last[1]) : "0");
  showMeasurement();
  drawEnergy($("#energySvg"), samples, latest.time, effectiveMethod(settings));
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
  if (!latest) {
    defaultMark = defaultMarkedParticle(message.positions, settings.setup);
    needsFrame = true;
  }
  latest = message;
  if (stepped && view.running) {
    keepTrails(message);
  }
  if (message.measurement) {
    measurement = message.measurement;
  }
  showCaption();
  draw(stepped);
  framesSinceReadout += 1;
  if (framesSinceReadout >= READOUT_INTERVAL_FRAMES || !view.running || message.measurement) {
    framesSinceReadout = 0;
    showReadouts();
  }
}

// Worker

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
    speed: view.speed,
    probe: markedParticle(),
    wantCells: view.showCells && settings.method === "tree",
    resendCells: cells === null,
  });
}

// Results

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

start().catch((error) => fail(error.message));
