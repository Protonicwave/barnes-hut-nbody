// The Python call that repeats the run on screen: the same setup, settings and
// number of steps, as text a visitor can copy.

import { TIMESTEP_LABELS, effectiveMethod, particleCount, stepsTaken } from "./settings.js";

const KEPLER_CALL = "bh.kepler_binary(eccentricity=0.5, semi_major_axis=1.0)";
const SETUP_FUNCTIONS = { plummer: "plummer_sphere", collapse: "uniform_sphere" };

// The random setups use the seed on screen, but the Python build need not draw
// the same particles as this tab: the C++ draws two random values in one
// expression, and compilers order those differently.
const SEEDED_NOTE = "# same seed; the starting particles can differ from this tab by platform";

function setupLines(settings) {
  if (settings.setup === "kepler") {
    return [`positions, velocities, masses = ${KEPLER_CALL}`];
  }
  const call = `bh.${SETUP_FUNCTIONS[settings.setup]}(${particleCount(settings)}, seed=${settings.seed})`;
  return [SEEDED_NOTE, `positions, velocities, masses = ${call}`];
}

const softeningText = (settings) =>
  settings.setup === "kepler" ? "0" : `${settings.softeningScale} / np.sqrt(${particleCount(settings)})`;

// Direct summation has no opening angle to state.
function forceArguments(settings) {
  const method = effectiveMethod(settings);
  const theta = method === "direct" ? "" : ` theta=${settings.theta},`;
  return `method="${method}",${theta} threads=${settings.threads},`;
}

// forceChangedAt is the time of the last method or theta change, or null. One
// call cannot change the force part way, so the record says it runs the
// current settings from the start.
export function runRecord(settings, time, forceChangedAt) {
  const lines = [];
  if (forceChangedAt !== null) {
    lines.push(`# method or theta changed at t = ${forceChangedAt.toFixed(2)}; this call runs the current settings from t = 0`);
  }
  const steps = stepsTaken(settings, time);
  lines.push(
    "import numpy as np",
    "import barnes_hut as bh",
    "",
    ...setupLines(settings),
    "simulation = bh.Simulation(",
    "    positions, velocities, masses,",
    `    dt=${TIMESTEP_LABELS[settings.timestepIndex].replace("/", " / ")}, softening=${softeningText(settings)},`,
    `    ${forceArguments(settings)}`,
    ")",
    "start = simulation.total_energy()");
  if (steps > 0) {
    lines.push(`simulation.step(${steps})`);
  }
  lines.push("print(abs(simulation.total_energy() - start) / abs(start))");
  return lines.join("\n");
}
