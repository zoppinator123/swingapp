// Heuristic swing-phase detection from the wrist trajectory.
//
// Image y grows downward, so the top of the backswing is the *minimum* of
// the wrist-height series. The heuristics assume one swing per clip.

import { LM, mid } from "./metrics.js";

function movingAverage(values, radius) {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (values[j] != null) {
        sum += values[j];
        n++;
      }
    }
    return n ? sum / n : null;
  });
}

function fillGaps(values) {
  let last = null;
  const forward = values.map((v) => (v != null ? (last = v) : last));
  last = null;
  for (let i = forward.length - 1; i >= 0; i--) {
    if (forward[i] != null) last = forward[i];
    else forward[i] = last;
  }
  return forward;
}

// Returns { address, top, impact, finish } as frame indices, or null when
// not enough of the body was tracked to decide.
export function detectPhases(frames) {
  const raw = frames.map((f) =>
    f.landmarks ? mid(f.landmarks[LM.L_WRIST], f.landmarks[LM.R_WRIST]).y : null
  );
  if (raw.filter((v) => v != null).length < 10) return null;

  const ys = movingAverage(fillGaps(raw), 2);
  const speed = ys.map((v, i) => (i ? Math.abs(v - ys[i - 1]) : 0));
  const maxSpeed = Math.max(...speed);
  if (maxSpeed === 0) return null;
  // Threshold low enough to catch a deliberate slow takeaway: the downswing
  // peak (maxSpeed) can be 20x takeaway speed.
  const moving = speed.map((s) => s > maxSpeed * 0.05);

  // The fastest wrist motion in any swing is the downswing. Anchoring on it
  // keeps a high-hands finish hold from masquerading as the top of the
  // backswing (the wrists are high there too).
  let fastIdx = 1;
  for (let i = 1; i < speed.length; i++) {
    if (speed[i] > speed[fastIdx]) fastIdx = i;
  }

  // Address: the last quiet frame before the first sustained motion.
  let motionStart = 1;
  for (let i = 1; i < moving.length - 2; i++) {
    if (moving[i] && moving[i + 1] && moving[i + 2]) {
      motionStart = i;
      break;
    }
  }
  if (motionStart >= fastIdx) motionStart = Math.max(1, fastIdx - 1);
  const address = Math.max(0, motionStart - 1);

  // Top: highest wrist point between the takeaway and the downswing.
  let top = motionStart;
  for (let i = motionStart; i <= fastIdx; i++) {
    if (ys[i] < ys[top]) top = i;
  }

  // Impact: first frame after the top where the wrists drop back to their
  // address height. If they never quite get there (slow-mo clips cut early,
  // strong shaft lean), use the frame where they come closest — the lowest
  // wrist point after the top.
  let impact = -1;
  for (let i = top + 1; i < ys.length; i++) {
    if (ys[i] >= ys[address]) {
      impact = i;
      break;
    }
  }
  if (impact < 0) {
    impact = top + 1;
    for (let i = top + 1; i < ys.length; i++) {
      if (ys[i] > ys[impact]) impact = i;
    }
  }

  // Finish: when motion settles after impact, else the last frame.
  let finish = frames.length - 1;
  for (let i = impact + 3; i < moving.length - 2; i++) {
    if (!moving[i] && !moving[i + 1] && !moving[i + 2]) {
      finish = i;
      break;
    }
  }

  // Guarantee strictly increasing checkpoints so downstream tempo / time-warp
  // never see a zero or negative span on a degenerate clip.
  const last = frames.length - 1;
  if (top <= address) top = Math.min(address + 1, last);
  if (impact <= top) impact = Math.min(top + 1, last);
  if (finish <= impact) finish = Math.min(impact + 1, last);

  return { address, top, impact, finish };
}

// Swing tempo from the checkpoint timestamps: backswing (address→top) vs
// downswing (top→impact), in video seconds. The ratio survives slow-motion
// clips since both phases are scaled equally. Note this is wrist-based —
// the wrists peak before the club finishes setting, so ratios read lower
// than the classic club-based "3:1" (Justin Thomas measures ~1.9:1 through
// this same pipeline).
export function swingTempo(frames, phases) {
  const t = (p) => frames[phases[p]]?.t;
  const address = t("address");
  const top = t("top");
  const impact = t("impact");
  if (address == null || top == null || impact == null) return null;
  const backswing = top - address;
  const downswing = impact - top;
  if (backswing <= 0 || downswing <= 0) return null;
  return { backswing, downswing, ratio: backswing / downswing };
}

// Acceptable band around a benchmark tempo ratio.
export function tempoWindow(benchmark) {
  return { min: benchmark * 0.7, max: benchmark * 1.45 };
}
