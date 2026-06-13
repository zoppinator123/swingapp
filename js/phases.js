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

  return { address, top, impact, finish };
}
