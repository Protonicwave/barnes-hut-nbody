const text = (id, value) => {
  document.getElementById(id).textContent = value;
};

text("isolated", String(self.crossOriginIsolated));
document.getElementById("banner").hidden = self.crossOriginIsolated;

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

worker.onmessage = ({ data }) => {
  if (data.type === "ready") {
    text("build", data.variant === "threads" ? "WebAssembly, threaded" : "WebAssembly, single-threaded");
    text("count", String(data.count));
    text("threads", String(data.threads));
  } else if (data.type === "done") {
    text("steps", String(data.steps));
    text("step-time", `${data.stepMs.toFixed(1)} ms`);
    text("drift", data.drift.toExponential(2));
    text("state", "done");
    document.documentElement.dataset.state = "done";
  } else {
    text("state", `failed: ${data.message}`);
    document.documentElement.dataset.state = "failed";
  }
};

worker.onerror = (event) => {
  text("state", `failed: ${event.message}`);
  document.documentElement.dataset.state = "failed";
};
