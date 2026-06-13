import { createLandmarker, analyzeVideo } from "./pose.js";
import { detectPhases, swingTempo, tempoWindow } from "./phases.js";
import { computeMetrics, gradeMetrics, METRIC_LABELS, formatMetricValue } from "./metrics.js";
import { loadReference, PHASE_LABELS } from "./reference.js";
import { loadGhost, createGhostTimeWarp, createGhostAligner } from "./ghost.js";
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
  adjustRow: $("adjust-row"),
  adjust: $("adjust"),
  adjustHint: $("adjust-hint"),
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
  tempoSection: $("tempo-section"),
  tempoRatio: $("tempo-ratio"),
  tempoValue: $("tempo-value"),
  tempoDetail: $("tempo-detail"),
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
  ghostWarp: null,
  chips: [],
  addressLm: null,
  current: 0,
  analyzing: false,
  adjustMode: false,
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
  state.ghostWarp = null;
  els.ghostControl.hidden = true;
  els.transport.hidden = true;
  setAdjustMode(false);
  els.adjustRow.hidden = true;
  els.report.hidden = true;
  els.tempoSection.hidden = true;
  els.feedbackSection.hidden = true;
  els.referenceInfo.hidden = true;
  els.phaseChips.innerHTML = "";
  state.chips = [];
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
  // Let the stage hug the clip (portrait phone videos especially); CSS caps
  // the height so tall clips don't push the controls off screen.
  els.videoWrap.style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`;
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
    state.ghost = await loadGhost(els.view.value);

    els.referenceName.textContent = state.ref.name;
    els.referenceInfo.hidden = false;

    setupTransport();
    recomputeFromPhases();
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

// Landmarks averaged over a small window around a frame — a steadier anchor
// for the ghost fit than any single frame's pose estimate.
function averagedLandmarks(center, radius = 2) {
  const acc = [];
  let n = 0;
  for (let i = center - radius; i <= center + radius; i++) {
    const lm = state.frames[i]?.landmarks;
    if (!lm) continue;
    n++;
    lm.forEach((p, k) => {
      acc[k] = acc[k] ? { x: acc[k].x + p.x, y: acc[k].y + p.y } : { x: p.x, y: p.y };
    });
  }
  return n ? acc.map((p) => ({ x: p.x / n, y: p.y / n })) : null;
}

// Everything derived from the checkpoints — metric anchors, the ghost fit
// and time warp, chips, report, feedback. Called after analysis and again
// whenever the user moves a checkpoint.
function recomputeFromPhases() {
  state.addressLm = state.frames[state.phases.address]?.landmarks ?? null;

  const anchorLm = averagedLandmarks(state.phases.address) ?? state.addressLm;
  state.ghostAlign =
    state.ghost && anchorLm
      ? createGhostAligner(state.ghost, anchorLm, els.overlay.width, els.overlay.height)
      : null;
  state.ghostWarp = state.ghostAlign
    ? createGhostTimeWarp(state.ghost, state.frames, state.phases)
    : null;
  els.ghostControl.hidden = !state.ghostAlign;

  renderPhaseChips();
  renderReport();
  renderTempo();
  renderFeedback();
}

// The reference swing's tempo ratio measured by the same wrist-based
// pipeline as the player's (frame indices; the frame rate cancels out).
function tempoBenchmark() {
  if (state.ghost?.phases) {
    const { address, top, impact } = state.ghost.phases;
    if (top > address && impact > top) return (top - address) / (impact - top);
  }
  return 1.9;
}

function renderTempo() {
  const tempo = swingTempo(state.frames, state.phases);
  if (!tempo) {
    els.tempoSection.hidden = true;
    return;
  }
  const benchmark = tempoBenchmark();
  const window = tempoWindow(benchmark);
  const ok = tempo.ratio >= window.min && tempo.ratio <= window.max;
  els.tempoValue.textContent = tempo.ratio.toFixed(1);
  els.tempoRatio.className = ok ? "good" : "bad";
  els.tempoDetail.textContent =
    `Backswing ${tempo.backswing.toFixed(2)} s, downswing ${tempo.downswing.toFixed(2)} s ` +
    `(video time). Reference: ${benchmark.toFixed(1)} : 1 measured the same wrist-based way — ` +
    `the classic club-based number reads ~3 : 1.`;
  els.tempoSection.hidden = false;
}

// --- Checkpoint adjustment ---------------------------------------------------

function setAdjustMode(on) {
  state.adjustMode = on;
  els.adjust.classList.toggle("active", on);
  els.adjustHint.hidden = !on;
  els.phaseChips.classList.toggle("adjusting", on);
  if (state.phases) renderPhaseChips();
}

els.adjust.addEventListener("click", () => setAdjustMode(!state.adjustMode));

function setPhase(phase, i) {
  if (!state.frames[i]) return;
  state.phases[phase] = i;
  recomputeFromPhases();
  drawFrame(state.current);
  els.status.textContent = `${PHASE_LABELS[phase]} moved to frame ${i + 1} — report and ghost updated.`;
}

// --- Playback & overlay ----------------------------------------------------

function setupTransport() {
  els.transport.hidden = false;
  els.adjustRow.hidden = false;
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
  if (state.ghostAlign && state.ghostWarp && els.ghostToggle.checked) {
    const gf = state.ghost.frames[state.ghostWarp(i)];
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
  updateActiveChip(i);
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
    els.play.classList.add("playing");
  } else {
    els.video.pause();
  }
});

els.ghostToggle.addEventListener("change", () => drawFrame(state.current));

els.video.addEventListener("pause", () => els.play.classList.remove("playing"));
els.video.addEventListener("ended", () => els.play.classList.remove("playing"));

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
  state.chips = [];
  for (const [phase, label] of Object.entries(PHASE_LABELS)) {
    const i = state.phases[phase];
    if (i == null) continue;
    const chip = document.createElement("button");
    chip.className = "phase-chip";
    chip.textContent = state.adjustMode ? `${label} · ${i + 1}` : label;
    chip.addEventListener("click", () => {
      els.video.pause();
      if (state.adjustMode) setPhase(phase, state.current);
      else showFrame(i);
    });
    els.phaseChips.appendChild(chip);
    state.chips.push({ idx: i, el: chip });
  }
}

// Highlights the chip of the phase the scrubber is currently inside.
function updateActiveChip(i) {
  if (!state.chips) return;
  let active = null;
  for (const c of state.chips) if (i >= c.idx) active = c.el;
  for (const c of state.chips) c.el.classList.toggle("active", c.el === active);
}

function renderReport() {
  const table = document.createElement("table");
  table.className = "metrics";
  table.innerHTML =
    "<tr><th>Checkpoint</th><th>Metric</th><th>Target</th><th>Value</th></tr>";

  const fmtRange = (name, r) => {
    const f = (v) => formatMetricValue(name, v);
    if (r.min != null && r.max != null) return `${f(r.min)} – ${f(r.max)}`;
    if (r.max != null) return `≤ ${f(r.max)}`;
    if (r.min != null) return `≥ ${f(r.min)}`;
    return "";
  };

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
        `<td class="target">${fmtRange(name, phaseRef[name])}</td>` +
        `<td><span class="${cls}">${formatMetricValue(name, metrics[name])}</span></td>`;
      table.appendChild(row);
    }
  }

  els.metrics.innerHTML = "";
  els.metrics.appendChild(table);
  els.report.hidden = false;
}

function renderFeedback() {
  const items = buildFeedback(state.frames, state.phases, state.ref, tempoBenchmark());
  els.feedback.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = item.title;
    const body = document.createElement("span");
    body.textContent = item.text;
    li.append(title, body);
    if (item.good) li.className = "good";
    if (item.phase != null && state.phases[item.phase] != null) {
      li.classList.add("jumpable");
      const jump = document.createElement("span");
      jump.className = "jump";
      jump.textContent = `Show me — jump to ${PHASE_LABELS[item.phase].toLowerCase()} ▸`;
      li.appendChild(jump);
      li.addEventListener("click", () => {
        els.video.pause();
        showFrame(state.phases[item.phase]);
        els.videoWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
    els.feedback.appendChild(li);
  }
  els.feedbackSection.hidden = false;
}
