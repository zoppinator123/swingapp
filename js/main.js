import { createLandmarker, analyzeVideo } from "./pose.js";
import { detectPhases, swingTempo, tempoWindow } from "./phases.js";
import { computeMetrics, gradeMetrics, METRIC_LABELS, formatMetricValue } from "./metrics.js";
import { loadReference, PHASE_LABELS } from "./reference.js";
import { loadGhost, createGhostTimeWarp, createGhostAligner } from "./ghost.js";
import { drawOverlay } from "./overlay.js";
import { buildPoseResult } from "./uncertainty.js";
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
  speed: $("speed"),
  loop: $("loop"),
  scrubber: $("scrubber"),
  frameLabel: $("frame-label"),
  phaseChips: $("phase-chips"),
  adjustRow: $("adjust-row"),
  adjust: $("adjust"),
  adjustHint: $("adjust-hint"),
  view: $("view"),
  file: $("file"),
  fileName: $("file-name"),
  record: $("record"),
  captureBar: $("capture-bar"),
  captureRecord: $("capture-record"),
  captureCancel: $("capture-cancel"),
  captureTimer: $("capture-timer"),
  analyze: $("analyze"),
  setup: $("setup"),
  newSwing: $("new-swing"),
  progress: $("progress"),
  status: $("status"),
  referenceInfo: $("reference-info"),
  referenceName: $("reference-name"),
  ghostControl: $("ghost-control"),
  ghostToggle: $("ghost-toggle"),
  uncertaintyControl: $("uncertainty-control"),
  uncertaintyToggle: $("uncertainty-toggle"),
  overlayLegend: $("overlay-legend"),
  summary: $("summary"),
  summaryHeadline: $("summary-headline"),
  summarySub: $("summary-sub"),
  summaryScore: $("summary-score"),
  report: $("report"),
  metrics: $("metrics"),
  tempoSection: $("tempo-section"),
  tempoRatio: $("tempo-ratio"),
  tempoValue: $("tempo-value"),
  tempoDetail: $("tempo-detail"),
  feedbackSection: $("feedback-section"),
  feedbackHint: $("feedback-hint"),
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
  rate: 1,
  loopSwing: false,
  // camera capture
  stream: null,
  recorder: null,
  chunks: [],
  recording: false,
  capturing: false,
  discardRecording: false,
  captureStart: 0,
  captureRaf: 0,
  captureAutoStop: 0,
};

const ctx = els.overlay.getContext("2d");

// --- Video loading ---------------------------------------------------------

function loadFile(file) {
  if (!file || !file.type.startsWith("video/")) return;
  loadSource(file, file.name);
}

// Shared load path for both a chosen File and a recorded Blob.
function loadSource(src, name) {
  els.video.srcObject = null;
  els.video.src = URL.createObjectURL(src);
  els.fileName.textContent = name;
  els.dropHint.hidden = true;
  state.frames = [];
  state.phases = null;
  state.addressLm = null;
  state.ghost = null;
  state.ghostAlign = null;
  state.ghostWarp = null;
  els.ghostControl.hidden = true;
  els.uncertaintyControl.hidden = true;
  els.transport.hidden = true;
  setAdjustMode(false);
  els.adjustRow.hidden = true;
  els.report.hidden = true;
  els.tempoSection.hidden = true;
  els.feedbackSection.hidden = true;
  els.referenceInfo.hidden = true;
  els.summary.hidden = true;
  els.overlayLegend.hidden = true;
  els.setup.hidden = false;
  els.newSwing.hidden = true;
  els.phaseChips.innerHTML = "";
  state.chips = [];
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  els.status.textContent = "";
}

els.file.addEventListener("change", () => loadFile(els.file.files[0]));
els.newSwing.addEventListener("click", () => {
  els.file.value = ""; // so re-selecting the same clip still fires "change"
  els.file.click();
});

// --- Camera capture --------------------------------------------------------

const captureSupported =
  !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
if (captureSupported) els.record.hidden = false;

const MAX_CAPTURE_MS = 20000;

function pickMimeType() {
  const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
}

async function enterCapture() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch {
    els.status.textContent =
      "Couldn't open the camera — check permissions, or choose a video file instead.";
    return;
  }
  state.stream = stream;
  state.capturing = true;
  // Clear any prior analysis and show the live preview.
  els.summary.hidden = els.feedbackSection.hidden = els.report.hidden = true;
  els.transport.hidden = els.adjustRow.hidden = els.overlayLegend.hidden = true;
  els.newSwing.hidden = true;
  els.phaseChips.innerHTML = "";
  els.analyze.disabled = true;
  els.dropHint.hidden = true;
  els.video.pause();
  els.video.removeAttribute("src");
  els.video.srcObject = stream;
  els.video.muted = true;
  els.video.play().catch(() => {});
  els.captureRecord.classList.remove("recording");
  els.captureBar.classList.remove("live");
  els.captureTimer.textContent = "0.0s";
  els.captureBar.hidden = false;
}

function toggleRecord() {
  if (!state.stream) return;
  if (state.recording) return stopRecording();
  const mimeType = pickMimeType();
  state.chunks = [];
  state.discardRecording = false;
  try {
    state.recorder = mimeType
      ? new MediaRecorder(state.stream, { mimeType })
      : new MediaRecorder(state.stream);
  } catch {
    state.recorder = new MediaRecorder(state.stream);
  }
  state.recorder.ondataavailable = (e) => { if (e.data?.size) state.chunks.push(e.data); };
  state.recorder.onstop = finalizeRecording;
  state.recorder.start();
  state.recording = true;
  els.captureRecord.classList.add("recording");
  els.captureRecord.setAttribute("aria-label", "Stop recording");
  els.captureBar.classList.add("live");
  state.captureStart = performance.now();
  tickTimer();
  state.captureAutoStop = setTimeout(() => state.recording && stopRecording(), MAX_CAPTURE_MS);
}

function tickTimer() {
  els.captureTimer.textContent =
    ((performance.now() - state.captureStart) / 1000).toFixed(1) + "s";
  if (state.recording) state.captureRaf = requestAnimationFrame(tickTimer);
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  clearTimeout(state.captureAutoStop);
  cancelAnimationFrame(state.captureRaf);
  els.captureRecord.classList.remove("recording");
  els.captureRecord.setAttribute("aria-label", "Start recording");
  els.captureBar.classList.remove("live");
  try { state.recorder.stop(); } catch {}
}

function finalizeRecording() {
  const type = state.recorder?.mimeType || "video/webm";
  const blob = new Blob(state.chunks, { type });
  stopStream();
  els.captureBar.hidden = true;
  state.capturing = false;
  if (state.discardRecording || !blob.size) {
    if (!els.video.getAttribute("src")) els.dropHint.hidden = false;
    return;
  }
  loadSource(blob, "Recorded swing");
  els.status.textContent = "Recorded — tap Analyze swing.";
}

function stopStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  els.video.srcObject = null;
}

function cancelCapture() {
  state.discardRecording = true;
  if (state.recording) return stopRecording(); // onstop → finalize honors discard
  stopStream();
  els.captureBar.hidden = true;
  state.capturing = false;
  if (!els.video.getAttribute("src")) els.dropHint.hidden = false;
}

els.record.addEventListener("click", enterCapture);
els.captureRecord.addEventListener("click", toggleRecord);
els.captureCancel.addEventListener("click", cancelCapture);

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
  els.video.playbackRate = state.rate; // playbackRate resets on a new source
  if (state.capturing) return; // live camera preview — not a loaded clip
  els.analyze.disabled = false;
  els.status.textContent = "Video loaded. Pick the camera view, then Analyze.";
});

// --- Analysis --------------------------------------------------------------

// MediaRecorder WebM has no duration in its header, so video.duration is
// Infinity until a seek past the end forces the browser to compute it.
// Returns the finite duration (seconds) or null if it can't be determined.
function ensureFiniteDuration(video) {
  const good = () => Number.isFinite(video.duration) && video.duration > 0;
  if (good()) return Promise.resolve(video.duration);
  return new Promise((resolve) => {
    const cleanup = () => {
      video.removeEventListener("durationchange", onChange);
      clearTimeout(timer);
    };
    const onChange = () => { if (good()) { cleanup(); resolve(); } };
    const timer = setTimeout(() => { cleanup(); resolve(); }, 3000);
    video.addEventListener("durationchange", onChange);
    try { video.currentTime = 1e101; } catch { cleanup(); resolve(); }
  }).then(() => {
    try { video.currentTime = 0; } catch {}
    return good() ? video.duration : null;
  });
}

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

    // Recorded WebM blobs report duration: Infinity until forced — repair it
    // so the frame-extraction loop terminates.
    const dur = await ensureFiniteDuration(els.video);
    if (!dur) {
      els.status.textContent =
        "Couldn't read this clip's length — try a different file or re-record.";
      return;
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

    els.referenceName.textContent = shortName(state.ref.name);
    els.referenceInfo.hidden = false;
    els.overlayLegend.hidden = !state.ghost;

    setupTransport();
    recomputeFromPhases();
    showFrame(state.phases.address);

    els.setup.hidden = true;
    els.newSwing.hidden = false;
    els.status.textContent = "";
    revealResults();
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
  renderSummary();
  renderTempo();
  renderFeedback();
  renderReport();
}

// Strips the parenthetical so the benchmark badge reads e.g. "Justin Thomas".
function shortName(name) {
  return name.replace(/\s*\(.*\)\s*$/, "").trim();
}

const fmtRange = (name, r) => {
  const f = (v) => formatMetricValue(name, v);
  if (r.min != null && r.max != null) return `${f(r.min)} – ${f(r.max)}`;
  if (r.max != null) return `≤ ${f(r.max)}`;
  if (r.min != null) return `≥ ${f(r.min)}`;
  return "";
};

// One-line reveal of the result cards after analysis (not on re-compute).
function revealResults() {
  for (const el of [els.summary, els.feedbackSection, els.report]) {
    el.classList.remove("reveal");
    void el.offsetWidth;
    el.classList.add("reveal");
  }
}

// Headline verdict: how many checkpoints match, and a plain-English read.
function renderSummary() {
  let total = 0;
  let pass = 0;
  for (const phase of ["address", "top", "impact"]) {
    const lm = state.frames[state.phases[phase]]?.landmarks;
    const phaseRef = state.ref.phases[phase];
    if (!lm || !phaseRef) continue;
    const grades = gradeMetrics(computeMetrics(lm, state.addressLm), phaseRef);
    for (const k in grades) {
      total++;
      if (grades[k]) pass++;
    }
  }

  const issues = buildFeedback(state.frames, state.phases, state.ref, tempoBenchmark())
    .filter((i) => !i.good);
  const n = issues.length;
  const name = shortName(state.ref.name);

  els.summaryHeadline.textContent =
    n === 0 ? "Dialed in" :
    n === 1 ? "One thing to sharpen" :
    n === 2 ? "A couple of fixes" :
    "Let's tighten it up";
  els.summarySub.textContent =
    n === 0
      ? `Every checkpoint matches ${name}. Keep grooving it.`
      : `${pass} of ${total} checkpoints match ${name}.`;
  els.summaryScore.textContent = `${pass}/${total}`;
  els.summaryScore.classList.toggle("good", total > 0 && pass === total);
  els.summary.hidden = false;
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
  els.uncertaintyControl.hidden = false; // available whenever there are frames
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

  // Per-joint uncertainty ellipses, computed on demand from a short window of
  // frames around this one (cheap: 13 joints over a handful of frames).
  let ellipses = null;
  if (els.uncertaintyToggle.checked && frame.landmarks) {
    ellipses = buildPoseResult(
      state.frames,
      i,
      els.overlay.width,
      els.overlay.height,
    ).ellipses;
  }

  drawOverlay(ctx, els.overlay.width, els.overlay.height, frame.landmarks, {
    addressLm: state.addressLm,
    spineRange,
    headTolerance,
    posturePhase,
    ghostLm,
    ellipses,
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

els.play.addEventListener("click", () => togglePlay());

els.ghostToggle.addEventListener("change", () => drawFrame(state.current));
els.uncertaintyToggle.addEventListener("change", () => drawFrame(state.current));

// Drive the play/pause icon from the media events so every path (button,
// click-to-play, keyboard, loop restart) stays in sync.
els.video.addEventListener("play", () => els.play.classList.add("playing"));
els.video.addEventListener("pause", () => els.play.classList.remove("playing"));
els.video.addEventListener("ended", () => {
  if (state.loopSwing && state.phases) {
    els.video.currentTime = state.frames[state.phases.address]?.t ?? 0;
    els.video.play();
  } else {
    els.play.classList.remove("playing");
  }
});

// Click anywhere on the replay (except the ghost toggle) to play/pause —
// but never while analysis is seeking frame-by-frame, or it corrupts timing.
els.videoWrap.addEventListener("click", (e) => {
  if (e.target.closest("#ghost-control") || state.analyzing || !state.frames.length) return;
  togglePlay();
});

function togglePlay() {
  if (els.video.paused) {
    els.video.play();
  } else {
    els.video.pause();
  }
}

// Slow-motion: swing review lives at quarter and half speed.
els.speed.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-rate]");
  if (!btn) return;
  state.rate = Number(btn.dataset.rate);
  els.video.playbackRate = state.rate;
  for (const b of els.speed.children) b.classList.toggle("active", b === btn);
});

els.loop.addEventListener("click", () => {
  state.loopSwing = !state.loopSwing;
  els.loop.setAttribute("aria-pressed", String(state.loopSwing));
});

// Keyboard transport: space = play/pause, arrows = step a frame,
// Home/End = first/last frame. Ignored while typing in a control.
document.addEventListener("keydown", (e) => {
  if (!state.frames.length) return;
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
  // Space already activates a focused button/link; don't also toggle play.
  if (e.key === " " && (tag === "BUTTON" || tag === "A" || tag === "LABEL")) return;
  switch (e.key) {
    case " ": e.preventDefault(); togglePlay(); break;
    case "ArrowLeft": e.preventDefault(); els.video.pause(); showFrame(state.current - 1); break;
    case "ArrowRight": e.preventDefault(); els.video.pause(); showFrame(state.current + 1); break;
    case "Home": e.preventDefault(); els.video.pause(); showFrame(0); break;
    case "End": e.preventDefault(); els.video.pause(); showFrame(state.frames.length - 1); break;
    default: return;
  }
});

function playbackLoop() {
  if (!els.video.paused && state.frames.length) {
    // Loop the swing: when playback runs past the finish, jump back to address.
    if (state.loopSwing && state.phases) {
      const start = state.frames[state.phases.address]?.t ?? 0;
      const end = state.frames[state.phases.finish]?.t ?? els.video.duration;
      if (els.video.currentTime >= end || els.video.currentTime < start - 0.05) {
        els.video.currentTime = start;
      }
    }
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

// Scorecard: each phase a group, each metric a row with a status dot, the
// target window, and the player's value as a green/clay pill.
function renderReport() {
  els.metrics.innerHTML = "";

  for (const phase of ["address", "top", "impact"]) {
    const lm = state.frames[state.phases[phase]]?.landmarks;
    const phaseRef = state.ref.phases[phase];
    if (!lm || !phaseRef) continue;

    const metrics = computeMetrics(lm, state.addressLm);
    const grades = gradeMetrics(metrics, phaseRef);
    const names = Object.keys(phaseRef).filter((n) => metrics[n] != null);
    if (!names.length) continue;

    const group = document.createElement("div");
    group.className = "score-group";
    const head = document.createElement("div");
    head.className = "score-phase";
    head.textContent = PHASE_LABELS[phase];
    group.appendChild(head);

    for (const name of names) {
      const ok = grades[name];
      const row = document.createElement("div");
      row.className = "score-row";
      row.innerHTML =
        `<span class="score-dot ${ok ? "good" : "bad"}"></span>` +
        `<span class="score-metric">${METRIC_LABELS[name] ?? name}</span>` +
        `<span class="score-target">${fmtRange(name, phaseRef[name])}</span>` +
        `<span class="${ok ? "value-good" : "value-bad"}">${formatMetricValue(name, metrics[name])}</span>`;
      group.appendChild(row);
    }
    els.metrics.appendChild(group);
  }
  els.report.hidden = false;
}

function renderFeedback() {
  const items = buildFeedback(state.frames, state.phases, state.ref, tempoBenchmark());
  els.feedback.innerHTML = "";
  els.feedbackHint.hidden = !items.some(
    (i) => i.phase != null && state.phases[i.phase] != null
  );
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
