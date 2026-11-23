// The guided experiments for a first visit: what each one sets, which panel
// it points at and what to watch there. Written for a reader with little
// physics, so the copy says "star" where the controls say "particle".

import { withChange } from "./settings.js";

export const EXPERIMENTS = Object.freeze([
  Object.freeze({
    id: "shortcut",
    target: "#scope",
    settings: { countIndex: 4, method: "tree", theta: 0.5 },
    view: { speed: 1, showCells: false, running: true },
    watch: "The marked star counts each outlined box as one heavy point: big boxes far away, "
      + "small ones close by. Hover over or tap another star to see its boxes.",
  }),
  Object.freeze({
    id: "race",
    target: "#measured",
    settings: { countIndex: 5, method: "direct" },
    view: { speed: 4, showCells: false, running: true },
    watch: "This is the long way, with every pull counted one by one. Note the steps per second "
      + "at the top right of the display, then switch Method to Tree. Measured in this tab "
      + "times both ways on your computer.",
  }),
  Object.freeze({
    id: "too-far",
    target: "#conservation",
    settings: { countIndex: 4, method: "tree", theta: 1 },
    view: { speed: 16, showCells: false, running: true },
    // Measured at N = 4,096: θ = 1.0 settles 4 to 7 times above θ = 0.5, and
    // a longer timestep does not change that, so the copy promises a ratio,
    // not a steady climb.
    watch: "The shortcut is now at its crudest. Real gravity never changes the total energy of a "
      + "group of stars, so any change on the energy meter is the simulation's mistake. Note "
      + "where it settles, then set the opening angle back to 0.5 and press Reset: the mistake "
      + "is several times smaller.",
  }),
]);

// The settings an experiment runs with. Every experiment builds a fresh
// Plummer sphere, so the meters measure only what it shows; the thread count
// is the visitor's machine and stays as it is.
export function experimentSettings(current, experiment) {
  let next = { ...current, setup: "plummer", run: current.run + 1 };
  for (const [key, value] of Object.entries(experiment.settings)) {
    next = withChange(next, key, value);
  }
  return next;
}
