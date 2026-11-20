// The simulator's controls: the values each offers, what a setting means for
// the simulation, and what a change of one of them costs. Shared by the page
// and the worker, so the label a visitor reads and the number the simulation
// receives come from one place.

export const SETUPS = ["plummer", "collapse", "kepler"];
export const PARTICLE_COUNTS = [256, 512, 1024, 2048, 4096, 8192];
export const KEPLER_PARTICLE_COUNT = 2;
export const SOFTENING_SCALES = [1, 2, 4];
export const TIMESTEPS = [1 / 256, 1 / 128, 1 / 64];
export const TIMESTEP_LABELS = ["1/256", "1/128", "1/64"];
export const THREAD_CHOICES = [1, 2, 4, 8];
export const METHODS = ["direct", "tree"];

// Colour bands of particle speed, from slowest to fastest.
export const SPEED_BANDS = 14;

export const THETA_RANGE = { min: 0.2, max: 1, step: 0.1 };
// Opening angles above this are not recommended (Dehnen 2002).
export const THETA_WARNING_ABOVE = 0.7;

// Half the width of the square the viewport shows, in length units, and the
// speed that gets the brightest colour.
export const VIEW_RADIUS = { plummer: 2.3, collapse: 1.3, kepler: 1 };
export const REFERENCE_SPEED = { plummer: 1, collapse: 1.4, kepler: 0.7 };

export const DEFAULT_SETTINGS = Object.freeze({
  setup: "plummer",
  countIndex: 2,
  seed: 1,
  // Raised by Reset to rebuild the same setup.
  run: 0,
  method: "tree",
  theta: 0.5,
  softeningScale: 4,
  timestepIndex: 1,
  threads: 8,
});

// The default thread count is the most the build and the machine offer.
export function initialSettings(maxThreads, hardwareThreads) {
  const available = Math.min(maxThreads, hardwareThreads || 1);
  const threads = THREAD_CHOICES.filter((choice) => choice <= available).at(-1) ?? 1;
  return { ...DEFAULT_SETTINGS, threads };
}

export const particleCount = (settings) =>
  settings.setup === "kepler" ? KEPLER_PARTICLE_COUNT : PARTICLE_COUNTS[settings.countIndex];

export const softening = (settings) =>
  settings.setup === "kepler" ? 0 : settings.softeningScale / Math.sqrt(particleCount(settings));

export const timestep = (settings) => TIMESTEPS[settings.timestepIndex];

// What a change from one set of settings to another asks of the simulation:
// "restart" builds new particles, "method" keeps them and starts a new energy
// series, "tune" changes the opening angle or threads and keeps both, and
// "none" is no change.
export function changeKind(before, after) {
  const restartKeys = ["setup", "countIndex", "seed", "run", "softeningScale", "timestepIndex"];
  if (restartKeys.some((key) => before[key] !== after[key])) {
    return "restart";
  }
  if (before.method !== after.method) {
    return "method";
  }
  if (before.theta !== after.theta || before.threads !== after.threads) {
    return "tune";
  }
  return "none";
}

// The settings with one field changed. A theta from a range input is
// rounded to the grid, so 0.30000000000000004 never reaches the simulation.
export function withChange(settings, key, value) {
  const next = { ...settings, [key]: value };
  next.theta = Math.round(next.theta * 10) / 10;
  return next;
}

export const isEnergyBaselineReset = (kind) => kind === "restart" || kind === "method";

// How often the energy is summed, in steps. The sum is O(N^2).
export const energyInterval = (count) => (count > 2048 ? 32 : 16);

// The text beside each control, and so the value a visitor reads for it.
export function labels(settings) {
  return {
    count: particleCount(settings).toLocaleString("en-GB"),
    theta: settings.method === "direct" ? "off" : settings.theta.toFixed(1),
    softening: settings.setup === "kepler" ? "0" : softening(settings).toFixed(3),
    timestep: TIMESTEP_LABELS[settings.timestepIndex],
    seed: `seed ${settings.seed}`,
    threads: String(settings.threads),
  };
}

// Which controls the settings leave out of use.
export function controlState(settings) {
  const kepler = settings.setup === "kepler";
  const direct = settings.method === "direct";
  return {
    countDisabled: kepler,
    softeningDisabled: kepler,
    thetaDisabled: direct,
    thetaWarning: !direct && settings.theta > THETA_WARNING_ABOVE,
    cellsHidden: kepler,
  };
}

// What the page shows for the state of the WebAssembly module: "loading",
// "ready" (with the build that loaded) or "failed".
export function moduleState(status, variant, threads) {
  const ready = status === "ready";
  const badges = {
    loading: "Loading",
    failed: "Not running",
    ready: variant === "single" ? "WebAssembly, one thread" : `WebAssembly, ${threads} thread${threads > 1 ? "s" : ""}`,
  };
  return {
    showLoading: status === "loading",
    showFailed: status === "failed",
    showReload: status === "failed",
    controlsDisabled: !ready,
    showBanner: ready && variant === "single",
    threadsDisabled: variant === "single",
    badge: badges[status],
  };
}
