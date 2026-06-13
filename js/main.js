import { createLandmarker, analyzeVideo } from "./pose.js";
import { detectPhases } from "./phases.js";
import { computeMetrics, gradeMetrics, METRIC_LABELS } from "./metrics.js";
import { loadReference, PHASE_LABELS } from "./reference.js";
import { loadGhost, ghostFrameIndex, createGhostAligner } from "./ghost.js";
import { drawOverlay } from "./overlay.js";
import { buildFeedback } from "./feedback.js";

const $ = (id) => document.getElementById(id);
const els = {
  video: $("video"),
  overlay: $("overlay"),
  dropHint: $("drop-hint"),
  videoWrap: $("video-wrap"),
  transport: $("transport"),
  play: $("play"),
  prev: $("prev"),
  next: $("next"),
  scrubber: $("scrubber"),
  frameLabel: $("frame-label"),
  phaseChips: $("phase-chips"),
  view: $("view"),
  file: $("file"),
  fileName: $("file-name"),
  analyze: $("analyze"),
  progress: $("progress"),
  status: $("status"),
  referenceInfo: $("reference-info"),
  referenceName: $("reference-name"),
  ghostControl: $("ghost-control"),
  ghostToggle: $("ghost-toggle"),
  report: $("report"),
  metrics: $("metrics"),
  feedbackSection: $("feedback-section"),
  feedback: $("feedback"),
};

const state = {
  landmarker: null,
  frames: [],
  phases: null,
  ref: null,
  ghost: null,
  ghostAlign: null,
  addressLm: null,
  current: 0,
  analyzing: false,
};

const ctx = els.overlay.getContext("2d");

// --- Video loading ---------------------------------------------------------

function loadFile(file) {
  if (!file || !file.type.startsWith("video/")) return;
  els.video.src = URL.createObjectURL(file);
  els.fileName.textContent = file.name;
  els.dropHint.hidden = true;
  state.frames = [];
  state.phases = null;
  state.addressLm = null;
  state.ghost = null;
  state.ghostAlign = null;
  els.ghostControl.hidden = true;
  els.transport.hidden = true;
  els.report.hidden = true;
  els.feedbackSection.hidden = true;
  els.referenceInfo.hidden = true;
  els.phaseChips.innerHTML = "";
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  els.status.textContent = "";
}

els.file.addEventListener("change", () => loadFile(els.file.files[0]));

els.videoWrap.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.videoWrap.classList.add("dragover");
});
els.videoWrap.addEventListener("dragleave", () =>
  els.videoWrap.classList.remove("dragover")
);
els.videoWrap.addEventListener("drop", (e) => {
  e.preventDefault();
  els.videoWrap.classList.remove("dragover");
  loadFile(e.dataTransfer.files[0]);
});

els.video.addEventListener("loadedmetadata", () => {
  els.overlay.width = els.video.videoWidth;
  els.overlay.height = els.video.videoHeight;
  els.analyze.disabled = false;
  els.status.textContent = "Video loaded. Pick the camera view, then Analyze.";
});

// --- Analysis --------------------------------------------------------------

els.analyze.addEventListener("click", async () => {
  if (state.analyzing) return;
  state.analyzing = true;
  els.analyze.disabled = true;
  els.progress.hidden = false;
  els.progress.value = 0;

  try {
    if (!state.landmarker) {
      els.status.textContent = "Loading pose model (first run only)…";
      state.landmarker = await createLandmarker();
    }

    els.status.textContent = "Extracting pose frame by frame…";
    state.frames = await analyzeVideo(els.video, state.landmarker, {
      fps: 30,
      onProgress: (p) => (els.progress.value = p),
    });

    state.phases = detectPhases(state.frames);
    if (!state.phases) {
      els.status.textContent =
        "Couldn't track a body in this clip. Make sure the full body is visible and well lit.";
      return;
    }

    state.ref = await loadReference(els.view.value);
    state.addressLm = state.frames[state.phases.address]?.landmarks ?? null;

    state.ghost = await loadGhost(els.view.value);
    state.ghostAlign =
      state.ghost && state.addressLm
        ? createGhostAligner(state.ghost, state.addressLm, els.overlay.width, els.overlay.height)
        : null;
    els.ghostControl.hidden = !state.ghostAlign;

    els.referenceName.textContent = state.ref.name;
    els.referenceInfo.hidden = false;

    setupTransport();
    renderPhaseChips();
    renderReport();
    renderFeedback();
    showFrame(state.phases.address);

    els.status.textContent =
      "Done. Scrub the timeline or jump to a checkpoint. Green = inside the reference window, red = outside.";
  } catch (err) {
    console.error(err);
    els.status.textContent = `Analysis failed: ${err.message}`;
  } finally {
    state.analyzing = false;
    els.analyze.disabled = false;
    els.progress.hidden = true;
  }
});

// --- Playback & overlay ----------------------------------------------------

function setupTransport() {
  els.transport.hidden = false;
  els.scrubber.max = state.frames.length - 1;
  els.scrubber.value = 0;
}

function nearestFrame(t) {
  let lo = 0;
  let hi = state.frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state.frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function drawFrame(i) {
  const frame = state.frames[i];
  if (!frame) return;

  // Posture guides apply from address through impact; after that the body
  // is intentionally rotating out of its setup posture.
  const posturePhase = i > state.phases.impact ? "done" : "active";
  const spineRange =
    els.view.value === "down-the-line"
      ? state.ref?.phases?.address?.spineAngle
      : null;
  const headTolerance =
    state.ref?.phases?.impact?.headSway?.max ??
    state.ref?.phases?.top?.headSway?.max ??
    null;

  let ghostLm = null;
  if (state.ghostAlign && els.ghostToggle.checked) {
    const gf = state.ghost.frames[ghostFrameIndex(state.ghost, state.phases, i)];
    if (gf) ghostLm = state.ghostAlign(gf);
  }

  drawOverlay(ctx, els.overlay.width, els.overlay.height, frame.landmarks, {
    addressLm: state.addressLm,
    spineRange,
    headTolerance,
    posturePhase,
    ghostLm,
  });

  els.frameLabel.textContent = `${i + 1} / ${state.frames.length}`;
}

function showFrame(i) {
  i = Math.max(0, Math.min(state.frames.length - 1, i));
  state.current = i;
  els.scrubber.value = i;
  els.video.currentTime = state.frames[i].t;
  drawFrame(i);
}

els.scrubber.addEventListener("input", () => showFrame(Number(els.scrubber.value)));
els.prev.addEventListener("click", () => showFrame(state.current - 1));
els.next.addEventListener("click", () => showFrame(state.current + 1));

els.play.addEventListener("click", () => {
  if (els.video.paused) {
    els.video.play();
    els.play.textContent = "⏸";
  } else {
    els.video.pause();
    els.play.textContent = "▶";
  }
});

els.ghostToggle.addEventListener("change", () => drawFrame(state.current));

els.video.addEventListener("pause", () => (els.play.textContent = "▶"));
els.video.addEventListener("ended", () => (els.play.textContent = "▶"));

function playbackLoop() {
  if (!els.video.paused && state.frames.length) {
    const i = nearestFrame(els.video.currentTime);
    state.current = i;
    els.scrubber.value = i;
    drawFrame(i);
  }
  requestAnimationFrame(playbackLoop);
}
requestAnimationFrame(playbackLoop);

// --- Report UI -------------------------------------------------------------

function renderPhaseChips() {
  els.phaseChips.innerHTML = "";
  for (const [phase, label] of Object.entries(PHASE_LABELS)) {
    const i = state.phases[phase];
    if (i == null) continue;
    const chip = document.createElement("button");
    chip.className = "phase-chip";
    chip.textContent = label;
    chip.addEventListener("click", () => {
      els.video.pause();
      showFrame(i);
    });
    els.phaseChips.appendChild(chip);
  }
}

function renderReport() {
  const table = document.createElement("table");
  table.className = "metrics";
  table.innerHTML = "<tr><th>Checkpoint</th><th>Metric</th><th>Value</th></tr>";

  for (const phase of ["address", "top", "impact"]) {
    const lm = state.frames[state.phases[phase]]?.landmarks;
    const phaseRef = state.ref.phases[phase];
    if (!lm || !phaseRef) continue;

    const metrics = computeMetrics(lm, state.addressLm);
    const grades = gradeMetrics(metrics, phaseRef);

    for (const name of Object.keys(phaseRef)) {
      if (metrics[name] == null) continue;
      const row = document.createElement("tr");
      const cls = grades[name] ? "value-good" : "value-bad";
      row.innerHTML =
        `<td>${PHASE_LABELS[phase]}</td>` +
        `<td>${METRIC_LABELS[name] ?? name}</td>` +
        `<td class="${cls}">${metrics[name].toFixed(2)}</td>`;
      table.appendChild(row);
    }
  }

  els.metrics.innerHTML = "";
  els.metrics.appendChild(table);
  els.report.hidden = false;
}

function renderFeedback() {
  const items = buildFeedback(state.frames, state.phases, state.ref);
  els.feedback.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item.text;
    if (item.good) li.className = "good";
    els.feedback.appendChild(li);
  }
  els.feedbackSection.hidden = false;
}
