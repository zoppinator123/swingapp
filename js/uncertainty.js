// Per-joint pose uncertainty as 2D covariance ellipses.
//
// Background: the original brief wanted RF-DETR Keypoints, which was pitched
// as predicting a per-joint uncertainty ellipse. In reality RF-DETR's keypoint
// head only emits (x, y, visibility) — the same shape as the MediaPipe model
// this app already runs in-browser — so there is no covariance to read out of
// the network. Instead we *derive* a genuine uncertainty signal from data we
// already have: how much each landmark jitters over a short time window, scaled
// up where the model reports low visibility. A joint the tracker is unsure of
// (occluded, motion-blurred, low contrast) jumps around frame-to-frame and/or
// reports low visibility → a large ellipse; a confidently tracked joint stays
// put → a tight ellipse.
//
// Everything here is pure math/data (no DOM, no canvas) so it can be unit
// tested under Node. Drawing lives in overlay.js (drawUncertaintyEllipses).

import { LM, midHip, midShoulder } from "./metrics.js";

// The joints we visualise, with COCO-style names (the brief asked for COCO
// naming for downstream compatibility). Indices are MediaPipe BlazePose's;
// these 13 happen to line up one-to-one with COCO keypoints.
export const TRACKED_JOINTS = [
  { index: LM.NOSE, name: "nose" },
  { index: LM.L_SHOULDER, name: "left_shoulder" },
  { index: LM.R_SHOULDER, name: "right_shoulder" },
  { index: LM.L_ELBOW, name: "left_elbow" },
  { index: LM.R_ELBOW, name: "right_elbow" },
  { index: LM.L_WRIST, name: "left_wrist" },
  { index: LM.R_WRIST, name: "right_wrist" },
  { index: LM.L_HIP, name: "left_hip" },
  { index: LM.R_HIP, name: "right_hip" },
  { index: LM.L_KNEE, name: "left_knee" },
  { index: LM.R_KNEE, name: "right_knee" },
  { index: LM.L_ANKLE, name: "left_ankle" },
  { index: LM.R_ANKLE, name: "right_ankle" },
];

const DEFAULTS = {
  window: 3, // ± frames sampled around the current one for the jitter estimate
  kSigma: 2.4, // how many standard deviations the drawn ellipse spans
  visibilityInflation: 1.6, // extra growth as visibility → 0
  minRadiusFrac: 0.012, // floor on each semi-axis, as a fraction of torso length
  maxRadiusFrac: 0.16, // ceiling, same units (keeps wild frames legible)
  highUncertaintyFrac: 0.11, // mean radius that maps to "fully red" for colouring
};

// Sample 2x2 covariance of a set of {x, y} points, plus their mean.
// n < 2 yields a zero covariance (no spread can be estimated).
export function covariance2d(points) {
  const n = points.length;
  if (n === 0) return { mx: 0, my: 0, cxx: 0, cxy: 0, cyy: 0, n };
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  if (n < 2) return { mx, my, cxx: 0, cxy: 0, cyy: 0, n };

  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  const d = n - 1; // sample covariance
  return { mx, my, cxx: cxx / d, cxy: cxy / d, cyy: cyy / d, n };
}

// Eigen-decomposition of the symmetric covariance matrix [[cxx, cxy],[cxy, cyy]].
// Returns the ellipse orientation and the standard deviation along each
// principal axis: major ≥ minor, angle in degrees of the major axis from +x.
export function eigenEllipse(cxx, cxy, cyy) {
  const tr = cxx + cyy;
  const disc = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
  const lambdaMajor = Math.max(0, tr / 2 + disc);
  const lambdaMinor = Math.max(0, tr / 2 - disc);
  // 0.5·atan2(2·cxy, cxx−cyy) is the major-axis angle for any symmetric 2x2.
  const angle = (0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180) / Math.PI;
  return { angle, major: Math.sqrt(lambdaMajor), minor: Math.sqrt(lambdaMinor) };
}

// Torso length in *pixels* for the given normalized landmarks — the scale we
// express ellipse sizes against, so they are body-size and resolution
// independent. Returns null when the hips/shoulders aren't available.
function torsoLengthPx(lm, W, H) {
  if (!lm) return null;
  const hip = midHip(lm);
  const sh = midShoulder(lm);
  const dx = (hip.x - sh.x) * W;
  const dy = (hip.y - sh.y) * H;
  const len = Math.hypot(dx, dy);
  return len > 1 ? len : null;
}

// Build the unified PoseResult for frame `i`: keypoints (always) plus an
// uncertainty ellipse per joint that has enough temporal samples. Coordinates
// are in pixels (frame space), matching the documented data structure.
//
//   frames: [{ t, landmarks }] as produced by pose.js (landmarks normalized
//           0..1 with a `visibility` per point, or null when no body was found)
//   i:      index of the frame to describe
//   W, H:   frame pixel dimensions
//
// PoseResult = {
//   keypoints: [{ jointName, x, y, confidence }],
//   ellipses:  [{ jointName, cx, cy, width, height, angle, uncertainty }],
//   frameWidth, frameHeight,
// }
// where width/height are full axis *lengths* (not radii), angle is degrees,
// and `uncertainty` is a 0..1 score used for colouring.
export function buildPoseResult(frames, i, W, H, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const empty = { keypoints: [], ellipses: [], frameWidth: W, frameHeight: H };
  const current = frames[i]?.landmarks;
  if (!current) return empty;

  const torso = torsoLengthPx(current, W, H) ?? Math.hypot(W, H) * 0.25;
  const minR = o.minRadiusFrac * torso;
  const maxR = o.maxRadiusFrac * torso;
  const highR = o.highUncertaintyFrac * torso;

  const keypoints = [];
  const ellipses = [];

  for (const { index, name } of TRACKED_JOINTS) {
    const p = current[index];
    if (!p) continue;

    const cx = p.x * W;
    const cy = p.y * H;
    const confidence = p.visibility ?? p.score ?? 1;
    keypoints.push({ jointName: name, x: cx, y: cy, confidence });

    // Gather this joint's positions over the temporal window.
    const pts = [];
    for (let j = i - o.window; j <= i + o.window; j++) {
      const q = frames[j]?.landmarks?.[index];
      if (q) pts.push({ x: q.x * W, y: q.y * H });
    }
    // Need at least two samples to estimate spread; otherwise we fall back to
    // a keypoint with no ellipse (the brief's "point only" case).
    if (pts.length < 2) continue;

    const { cxx, cxy, cyy } = covariance2d(pts);
    const { angle, major, minor } = eigenEllipse(cxx, cxy, cyy);

    // Inflate as visibility drops: a still-but-unsure joint should still read
    // as uncertain, not confident.
    const inflate = 1 + o.visibilityInflation * (1 - clamp(confidence, 0, 1));
    const majorR = clamp(o.kSigma * major * inflate, minR, maxR);
    const minorR = clamp(o.kSigma * minor * inflate, minR, maxR);

    const meanR = Math.sqrt(majorR * minorR);
    const uncertainty = clamp(meanR / highR, 0, 1);

    ellipses.push({
      jointName: name,
      cx,
      cy,
      width: 2 * majorR,
      height: 2 * minorR,
      angle,
      uncertainty,
    });
  }

  return { keypoints, ellipses, frameWidth: W, frameHeight: H };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
