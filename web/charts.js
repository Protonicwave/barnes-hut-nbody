// The energy strip under the viewport and the figures in the results
// section. Every figure is drawn from web/data/results.json, so each number on
// the page is a committed measurement.

const SUPERSCRIPT = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
const powerOfTen = (exponent) => "10" + [...String(exponent)].map((c) => SUPERSCRIPT[c]).join("");

export const formatInteger = (x) => Math.round(x).toLocaleString("en-GB");

// 3.2×10⁻⁴
export function scientific(x) {
  if (!(x > 0)) {
    return "0";
  }
  const exponent = Math.floor(Math.log10(x));
  return `${(x / 10 ** exponent).toFixed(1)}×${powerOfTen(exponent)}`;
}

export const formatMilliseconds = (x) =>
  `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)} ms`;

// Where a value sits on a log scale from 10^lowDecade to 10^highDecade, from 0
// to 1. Zero and anything below the scale sit at 0, anything above at 1.
export function decadeFraction(value, lowDecade, highDecade) {
  if (!(value > 0)) {
    return 0;
  }
  const fraction = (Math.log10(value) - lowDecade) / (highDecade - lowDecade);
  return Math.min(1, Math.max(0, fraction));
}

const ENERGY = { height: 160, margin: { left: 44, right: 8, top: 8, bottom: 22 }, lowDecade: -7, highDecade: -1 };
const REFERENCE_DRIFT = 1e-3;
const MAX_TIME_TICKS = 6;

// The smallest of 1, 2 and 5 times a power of ten that is at least the step.
function niceStep(step) {
  const magnitude = 10 ** Math.floor(Math.log10(step));
  return [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= step);
}
const LABEL_GAP_PX = 13;

// Relative energy error against time, on a log axis with a line at 1e-3.
export function drawEnergy(svg, samples, time, method) {
  const width = svg.clientWidth || 600;
  const { height, margin: m, lowDecade, highDecade } = ENERGY;
  const plotWidth = width - m.left - m.right;
  const plotHeight = height - m.top - m.bottom;
  const tMin = samples.length > 0 ? samples[0][0] : 0;
  const tMax = Math.max(time, tMin + 4);
  const span = tMax - tMin;
  const y = (e) => m.top + plotHeight * (1 - decadeFraction(e, lowDecade, highDecade));
  const x = (t) => m.left + (plotWidth * (t - tMin)) / span;
  let markup = "";
  for (let decade = lowDecade; decade <= highDecade; decade += 2) {
    markup += `<line class="grid" x1="${m.left}" x2="${width - m.right}" y1="${y(10 ** decade)}" y2="${y(10 ** decade)}"/>` +
      `<text x="${m.left - 8}" y="${y(10 ** decade) + 4}" text-anchor="end">${powerOfTen(decade)}</text>`;
  }
  markup += `<line class="ref" x1="${m.left}" x2="${width - m.right}" y1="${y(REFERENCE_DRIFT)}" y2="${y(REFERENCE_DRIFT)}"/>`;
  const tickStep = niceStep(span / MAX_TIME_TICKS);
  for (let t = Math.ceil(tMin / tickStep) * tickStep; t <= tMax; t += tickStep) {
    markup += `<text x="${x(t)}" y="${height - 4}" text-anchor="middle">${t}</text>`;
  }
  markup += `<text x="${width - m.right}" y="${height - 4}" text-anchor="end" class="halo">time</text>`;
  if (samples.length > 1) {
    const path = samples.map(([t, e], k) => `${k ? "L" : "M"}${x(t).toFixed(1)} ${y(e).toFixed(1)}`).join("");
    markup += `<path class="line ${method === "tree" ? "l-tree" : "l-direct"}" d="${path}"/>`;
  }
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = markup;
}

// The marks at 2 to 9 times each power of ten inside a log axis.
function logMinorTicks(axis) {
  const marks = [];
  for (let decade = Math.floor(Math.log10(axis.min)); decade < Math.log10(axis.max); decade++) {
    for (let multiple = 2; multiple < 10; multiple++) {
      const value = multiple * 10 ** decade;
      if (value > axis.min && value < axis.max) {
        marks.push(value);
      }
    }
  }
  return marks;
}

// A line chart with optional log axes, reference lines, a shaded zone and
// end labels, which are moved apart where they would overlap.
function plot(svg, config) {
  const parent = svg.parentElement;
  const width = parent.clientWidth - (parent.matches(".plate") ? 32 : 0) || 520;
  const height = config.height ?? 300;
  const m = { left: config.marginLeft ?? 52, right: config.marginRight ?? 24, top: 30, bottom: 42 };
  const plotWidth = width - m.left - m.right;
  const plotHeight = height - m.top - m.bottom;
  const scaled = (value, axis) => (axis.log ? Math.log(value) : value);
  const fraction = (value, axis) =>
    (scaled(value, axis) - scaled(axis.min, axis)) / (scaled(axis.max, axis) - scaled(axis.min, axis));
  const x = (value) => m.left + plotWidth * fraction(value, config.x);
  const y = (value) => m.top + plotHeight * (1 - fraction(value, config.y));
  let markup = "";
  if (config.zone) {
    const [from, to] = config.zone;
    markup += `<defs><pattern id="hatch-${svg.id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>` +
      `<rect class="band-zone" x="${x(from)}" y="${m.top}" width="${x(to) - x(from)}" height="${plotHeight}"/>` +
      `<rect class="band-hatch" fill="url(#hatch-${svg.id})" x="${x(from)}" y="${m.top}" width="${x(to) - x(from)}" height="${plotHeight}"/>` +
      `<text class="t-soft" x="${x(from) + 6}" y="${m.top + plotHeight - 8}">${config.zoneLabel}</text>`;
  }
  for (const axis of [config.x, config.y]) {
    axis.minor = axis.log ? logMinorTicks(axis) : [];
  }
  for (const value of config.y.minor) {
    markup += `<line class="minor" x1="${m.left}" x2="${m.left + 4}" y1="${y(value)}" y2="${y(value)}"/>`;
  }
  for (const value of config.x.minor) {
    markup += `<line class="minor" x1="${x(value)}" x2="${x(value)}" y1="${m.top + plotHeight}" y2="${m.top + plotHeight - 4}"/>`;
  }
  for (const tick of config.y.ticks) {
    markup += `<line class="grid" x1="${m.left}" x2="${width - m.right}" y1="${y(tick)}" y2="${y(tick)}"/>` +
      `<text x="${m.left - 8}" y="${y(tick) + 4}" text-anchor="end">${config.y.format(tick)}</text>`;
  }
  markup += `<line class="axis" x1="${m.left}" x2="${width - m.right}" y1="${m.top + plotHeight}" y2="${m.top + plotHeight}"/>`;
  for (const tick of config.x.ticks) {
    markup += `<line class="axis" x1="${x(tick)}" x2="${x(tick)}" y1="${m.top + plotHeight}" y2="${m.top + plotHeight + 4}"/>` +
      `<text x="${x(tick)}" y="${m.top + plotHeight + 19}" text-anchor="middle">${config.x.format(tick)}</text>`;
  }
  markup += `<text x="${m.left}" y="12" class="t-soft" style="fill:var(--ink-2)">${config.y.label}</text>` +
    `<text x="${m.left + plotWidth}" y="${height - 4}" text-anchor="end">${config.x.label}</text>`;
  for (const reference of config.references ?? []) {
    markup += `<line class="ref" x1="${m.left}" x2="${width - m.right}" y1="${y(reference.y)}" y2="${y(reference.y)}"/>` +
      `<text class="halo" x="${m.left + 6}" y="${y(reference.y) - 6}">${reference.label}</text>`;
  }
  const labels = [];
  for (const series of config.series) {
    const path = series.points.map(([px, py], k) => `${k ? "L" : "M"}${x(px).toFixed(1)} ${y(py).toFixed(1)}`).join("");
    markup += `<path class="line ${series.lineClass}" d="${path}"/>`;
    if (series.dots) {
      for (const [px, py] of series.points) {
        markup += `<circle class="dot ${series.dotClass}" cx="${x(px)}" cy="${y(py)}" r="3.5"/>`;
      }
    }
    if (series.label) {
      const [lastX, lastY] = series.points.at(-1);
      labels.push({ x: x(lastX) + 8, y: y(lastY) + 4, text: series.label, textClass: series.textClass });
    }
  }
  separate(labels);
  for (const label of labels) {
    markup += `<text class="halo ${label.textClass}" x="${label.x}" y="${label.y}">${label.text}</text>`;
  }
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("height", height);
  svg.innerHTML = markup;
}

// Moves labels down, top to bottom, until each is LABEL_GAP_PX below the last.
function separate(labels) {
  labels.sort((a, b) => a.y - b.y);
  for (let k = 1; k < labels.length; k++) {
    labels[k].y = Math.max(labels[k].y, labels[k - 1].y + LABEL_GAP_PX);
  }
}

const findTiming = (rows, method, count, threads) =>
  rows.find((row) => row.method === method && row.count === count && row.threads === threads).median_ms;

const REFERENCE_COUNT = 65536;
const REFERENCE_THREADS = 8;
const THREAD_COUNTS = [1, 2, 4, 8];

function timingSeries(rows, method, key, fixed) {
  return rows
    .filter((row) => row.method === method && Object.entries(fixed).every(([name, value]) => row[name] === value))
    .sort((a, b) => a[key] - b[key])
    .map((row) => [row[key], row.median_ms]);
}

// The smallest particle count from which the tree beats direct summation at
// every count measured.
function crossoverCount(rows) {
  const counts = [...new Set(rows.filter((row) => row.method === "direct" && row.threads === REFERENCE_THREADS).map((row) => row.count))].sort((a, b) => a - b);
  const wins = counts.map((count) => findTiming(rows, "tree", count, REFERENCE_THREADS) < findTiming(rows, "direct", count, REFERENCE_THREADS));
  return counts[wins.lastIndexOf(false) + 1] ?? null;
}

const crossoverSentence = (count) =>
  count === null
    ? "The tree does not overtake direct summation at any count measured, and is"
    : `The tree overtakes direct summation at N = ${formatInteger(count)} and is`;

const threadsText = (threads) => `${threads} ${threads === 1 ? "thread" : "threads"}`;

// The caption of each plate, built only from what results.json holds. The
// speed and thread plates name the machine, since their numbers depend on it;
// the accuracy plates do not, since accuracy does not.
export function figureCaptions(data) {
  const rows = data.timing;
  const { cpu, physicalCores: cores } = data.machine;
  const machine = `${cpu}, ${cores} physical cores`;
  const efficiency = data.budgets.timing.min_scaling_efficiency;
  const treeMs = findTiming(rows, "tree", REFERENCE_COUNT, REFERENCE_THREADS);
  const speedup = findTiming(rows, "direct", REFERENCE_COUNT, REFERENCE_THREADS) / treeMs;
  const single = findTiming(rows, "tree", REFERENCE_COUNT, 1);
  const measured = single / findTiming(rows, "tree", REFERENCE_COUNT, REFERENCE_THREADS);
  const force = data.forceError.rows;
  const { curves, count: driftCount, timestep } = data.drift;
  const endTime = Math.max(...curves.flatMap((curve) => curve.points.map(([t]) => t)));
  const thetas = curves.filter((curve) => curve.method === "tree").map((curve) => curve.theta);
  return {
    time:
      `Direct summation grows as N², the tree as N log N. ${crossoverSentence(crossoverCount(rows))} ` +
      `${speedup.toFixed(1)} times faster at N = ${formatInteger(REFERENCE_COUNT)}, where one evaluation takes ${treeMs.toFixed(0)} ms. ` +
      `Both series use ${threadsText(REFERENCE_THREADS)} on ${machine}.`,
    threads:
      `One tree evaluation at N = ${formatInteger(REFERENCE_COUNT)}, against its own time on one thread, for ${THREAD_COUNTS.join(", ")} threads on ${machine}. ` +
      `${threadsText(REFERENCE_THREADS)} give ${measured.toFixed(1)} times, ` +
      `${measured >= efficiency * cores ? "above" : "below"} the ${efficiency} P limit of ${(efficiency * cores).toFixed(1)}.`,
    wasm:
      `Same kernel, N = ${formatInteger(data.wasm.count)}, θ = 0.5, timed under Node ${data.wasm.node.replace(/^v/, "")} on ${machine}, ` +
      `with ${threadsText(1)} and ${threadsText(REFERENCE_THREADS)}. The two builds draw different realisations of the same Plummer sphere.`,
    force:
      `Relative error of the tree force against direct summation, N = ${formatInteger(data.forceError.count)}, ε = 4/√N. ` +
      `Between θ = ${force[0].theta} and θ = ${force.at(-1).theta} the median error grows roughly as θ to the power ${fittedExponent(force, "median").toFixed(1)}.`,
    drift:
      `N = ${formatInteger(driftCount)}, Δt = 1/${Math.round(1 / timestep)}, ε = 4/√N, ${formatInteger(endTime / timestep)} steps, tree at θ = ${thetas.join(", ")}. ` +
      "Direct summation at the same step shows integration error alone. The gap above it is the tree.",
  };
}

function drawSpeed(data) {
  const rows = data.timing;
  const direct = timingSeries(rows, "direct", "count", { threads: REFERENCE_THREADS });
  const tree = timingSeries(rows, "tree", "count", { threads: REFERENCE_THREADS });
  plot(document.getElementById("figTime"), {
    marginRight: 70,
    height: 330,
    x: { log: true, min: 2 ** 10, max: 2 ** 17, ticks: [2 ** 10, 2 ** 12, 2 ** 14, 2 ** 16], format: formatInteger, label: "particles N" },
    y: { log: true, min: 0.1, max: 10000, ticks: [0.1, 1, 10, 100, 1000, 10000], format: String, label: `milliseconds, ${REFERENCE_THREADS} threads` },
    references: [{ y: data.budgets.timing.max_tree_ms, label: `${data.budgets.timing.max_tree_ms} ms budget at N = ${formatInteger(REFERENCE_COUNT)}` }],
    series: [
      { lineClass: "l-direct", textClass: "t-direct", label: "direct", points: direct },
      { lineClass: "l-tree", textClass: "t-tree", label: "tree", points: tree },
    ],
  });
  document.getElementById("capTime").textContent = figureCaptions(data).time;
}

function drawThreads(data) {
  const rows = data.timing;
  const efficiency = data.budgets.timing.min_scaling_efficiency;
  const single = findTiming(rows, "tree", REFERENCE_COUNT, 1);
  const speedups = THREAD_COUNTS.map((threads) => [threads, single / findTiming(rows, "tree", REFERENCE_COUNT, threads)]);
  plot(document.getElementById("figThreads"), {
    marginRight: 72,
    x: { min: 1, max: 8, ticks: THREAD_COUNTS, format: String, label: "threads" },
    y: { min: 0, max: 8, ticks: [0, 2, 4, 6, 8], format: String, label: "speedup over one thread" },
    series: [
      { lineClass: "l-dash", textClass: "t-soft", label: "ideal", points: THREAD_COUNTS.map((t) => [t, t]) },
      { lineClass: "l-dash", textClass: "t-soft", label: `${efficiency} × threads`, points: THREAD_COUNTS.map((t) => [t, efficiency * t]) },
      { lineClass: "l-tree", textClass: "t-tree", label: "tree", dots: true, dotClass: "dot-tree", points: speedups },
    ],
  });
  document.getElementById("capThreads").textContent = figureCaptions(data).threads;
}

function wasmRatio(runs, platform, threads) {
  const run = (name) => runs.find((entry) => entry.platform === name && entry.threads === threads).median_ms;
  return { wasm: run(platform), native: run("native") };
}

function fillWasmTable(data) {
  const { runs, count, node } = data.wasm;
  const rows = [
    ["Native, 1 thread", "native", 1],
    ["WebAssembly, 1 thread", "wasm-single", 1],
    ["Native, 8 threads", "native", 8],
    ["WebAssembly, 8 threads", "wasm-threads", 8],
  ];
  document.getElementById("wasmRows").innerHTML = rows.map(([label, platform, threads]) => {
    const { wasm, native } = wasmRatio(runs, platform, threads);
    const ms = platform === "native" ? native : wasm;
    return `<tr><td>${label}</td><td class="n" data-label="Time">${formatMilliseconds(ms)}</td>` +
      `<td class="n" data-label="Ratio">${(ms / native).toFixed(2)}×</td></tr>`;
  }).join("");
  document.getElementById("capWasm").textContent = figureCaptions(data).wasm;
}

// Exponent k of the power law m = a * theta^k through the first and last angle.
function fittedExponent(rows, key) {
  const first = rows[0];
  const last = rows.at(-1);
  return Math.log(last[key] / first[key]) / Math.log(last.theta / first.theta);
}

function drawForceError(data) {
  const rows = data.forceError.rows;
  plot(document.getElementById("figForce"), {
    marginRight: 100,
    x: { min: 0.2, max: 1, ticks: [0.2, 0.4, 0.6, 0.8, 1], format: (v) => v.toFixed(1), label: "opening angle θ" },
    y: { log: true, min: 1e-5, max: 1e-1, ticks: [1e-5, 1e-4, 1e-3, 1e-2, 1e-1], format: (v) => powerOfTen(Math.round(Math.log10(v))), label: "relative force error" },
    zone: [0.7, 1],
    zoneLabel: "not recommended",
    series: [
      { lineClass: "l-tree-soft", textClass: "t-soft", label: "99th percentile", points: rows.map((row) => [row.theta, row.p99]) },
      { lineClass: "l-tree", textClass: "t-tree", label: "median", points: rows.map((row) => [row.theta, row.median]) },
    ],
  });
  document.getElementById("capForce").textContent = figureCaptions(data).force;
}

const driftLabel = (curve) => (curve.method === "direct" ? "direct" : `θ = ${curve.theta}`);
const driftClasses = (curve) =>
  curve.method === "direct" ? ["l-direct", "t-direct"] : curve.theta === 0.5 ? ["l-tree", "t-tree"] : ["l-tree-soft", "t-soft"];

function drawDrift(data) {
  const { curves, count, timestep } = data.drift;
  const positive = curves.flatMap((curve) => curve.points.filter(([, e]) => e > 0));
  const decades = positive.map(([, e]) => Math.log10(e));
  const lowDecade = Math.floor(Math.min(...decades));
  const highDecade = Math.ceil(Math.max(...decades));
  const endTime = Math.max(...curves.flatMap((curve) => curve.points.map(([t]) => t)));
  const ticks = Array.from({ length: highDecade - lowDecade + 1 }, (_, k) => 10 ** (lowDecade + k));
  plot(document.getElementById("figDrift"), {
    marginRight: 64,
    x: { min: 0, max: endTime, ticks: [0, 5, 10, 15, 20, 25], format: String, label: "time, N-body units" },
    y: { log: true, min: 10 ** lowDecade, max: 10 ** highDecade, ticks, format: (v) => powerOfTen(Math.round(Math.log10(v))), label: "relative energy error" },
    references: [{ y: data.budgets.timing.max_tree_drift, label: "tree budget at θ = 0.5" }],
    series: curves.map((curve) => {
      const [lineClass, textClass] = driftClasses(curve);
      return { lineClass, textClass, label: driftLabel(curve), points: curve.points.filter(([, e]) => e > 0) };
    }),
  });
  document.getElementById("capDrift").textContent = figureCaptions(data).drift;
}

const maxDrift = (data, method, theta) =>
  Math.max(...data.drift.curves.find((curve) => curve.method === method && curve.theta === theta).points.map(([, e]) => e));

function fillBudgets(data) {
  const { timing: limits, wasm: wasmLimits } = data.budgets;
  const rows = data.timing;
  const cores = data.machine.physicalCores;
  const countText = formatInteger(REFERENCE_COUNT);
  const treeMs = findTiming(rows, "tree", REFERENCE_COUNT, REFERENCE_THREADS);
  const speedup = findTiming(rows, "direct", REFERENCE_COUNT, REFERENCE_THREADS) / treeMs;
  const scaling = findTiming(rows, "tree", REFERENCE_COUNT, 1) / findTiming(rows, "tree", REFERENCE_COUNT, cores);
  const ratios = rows
    .filter((row) => row.method === "direct" && row.threads === REFERENCE_THREADS && row.count >= limits.min_count_tree_wins)
    .map((row) => row.median_ms / findTiming(rows, "tree", row.count, REFERENCE_THREADS));
  const smallestRatio = Math.min(...ratios);
  const single = wasmRatio(data.wasm.runs, "wasm-single", 1);
  const threaded = wasmRatio(data.wasm.runs, "wasm-threads", 8);
  const wasmSingle = single.wasm / single.native;
  const wasmThreaded = threaded.wasm / threaded.native;
  const treeDrift = maxDrift(data, "tree", 0.5);
  const directDrift = maxDrift(data, "direct", null);
  const budgets = [
    [`Tree against direct, N = ${countText}, θ = 0.5, ${REFERENCE_THREADS} threads`, `at least ${limits.min_speedup_over_direct}× faster`, `${speedup.toFixed(1)}×`, speedup >= limits.min_speedup_over_direct],
    [`One tree force evaluation, N = ${countText}, θ = 0.5, ${REFERENCE_THREADS} threads`, `at most ${limits.max_tree_ms} ms`, `${treeMs.toFixed(0)} ms`, treeMs <= limits.max_tree_ms],
    [`Speedup from 1 to ${cores} threads`, `at least ${limits.min_scaling_efficiency} P`, `${scaling.toFixed(1)}×, ${(scaling / cores).toFixed(2)} P`, scaling >= limits.min_scaling_efficiency * cores],
    [`Tree faster than direct for every N from ${formatInteger(limits.min_count_tree_wins)}`, "every N", `at least ${smallestRatio.toFixed(1)}× faster`, smallestRatio >= 1],
    [`WebAssembly against native, N = ${formatInteger(data.wasm.count)}`, `at most ${wasmLimits.max_single_thread_ratio}× on one thread, ${wasmLimits.max_threaded_ratio}× on eight`, `${wasmSingle.toFixed(2)}×, ${wasmThreaded.toFixed(2)}×`, wasmSingle <= wasmLimits.max_single_thread_ratio && wasmThreaded <= wasmLimits.max_threaded_ratio],
    ["Energy error over the reference run, tree at θ = 0.5", `at most ${scientific(limits.max_tree_drift)}`, scientific(treeDrift), treeDrift <= limits.max_tree_drift],
    ["Energy error over the reference run, direct", `at most ${scientific(limits.max_direct_drift)}`, scientific(directDrift), directDrift <= limits.max_direct_drift],
  ];
  document.getElementById("budgetRows").innerHTML = budgets.map(([name, limit, measured, met]) =>
    `<tr><td>${name}</td><td class="n" data-label="Limit">${limit}</td><td class="n" data-label="Measured">${measured}</td>` +
    `<td class="${met ? "met" : "over"}" data-label="Status">${met ? "Met" : "Over"}</td></tr>`).join("");
}

// Draws every figure and fills every table and caption in the results section.
export function drawFigures(data) {
  drawSpeed(data);
  drawThreads(data);
  fillWasmTable(data);
  drawForceError(data);
  drawDrift(data);
  fillBudgets(data);
}
