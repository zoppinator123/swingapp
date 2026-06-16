// Per-joint pose uncertainty as 2D covariance ellipses.
//
// Background: the original brief wanted RF-DETR Keypoints, pitched as predicting
// a per-joint uncertainty ellipse. In reality RF-DETR's keypoint head emits only
// (x, y, visibility) — the same shape as the MediaPipe model this app already
// runs in-browser — so there is no covariance to read out of the network.
// Instead we *derive* a genuine uncertainty signal from data we already have.
//
// Three signals, combined:
//   1. Motion-compensated jitter. We fit each joint's smooth trajectory (a low-
//      order polynomial in time: position + velocity + acceleration) over a
//      short window and take the covariance of the *residuals* around that fit.
//      This is the key idea: a fast but well-tracked joint (a wrist in the
//      downswing) follows a smooth arc, so its residuals stay small — speed no
//      longer masquerades as uncertainty. Only genuine frame-to-frame wobble off
//      the smooth path inflates the ellipse. The residual covariance, eigen-
//      decomposed, also gives the ellipse's orientation (the direction the joint
//      is least certain in).
//   2. Depth (z) jitter. BlazePose estimates a per-joint depth; an occluded joint
//      often looks stable in 2D but flips in z. Residual z wobble inflates the
//      ellipse and reddens it even when x/y look calm.
//   3. Confidence. MediaPipe's per-joint visibility (× presence when available);
//      low confidence inflates the ellipse.
//
// Everything here is pure math/data (no DOM, no canvas) so it can be unit tested
// under Node. Drawing lives in overlay.js (drawUncertaintyEllipses).

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
  detrendDegree: 2, // remove smooth motion up to acceleration before measuring jitter
  kSigma: 3.0, // how many residual standard deviations the drawn ellipse spans
  visibilityWeight: 1.0, // additive ellipse growth at full occlusion (confidence → 0)
  depthWeight: 0.8, // additive ellipse growth at high depth (z) jitter
  confDepthScaleFrac: 0.08, // px scale (× torso) of one unit of the additive terms
  minRadiusFrac: 0.012, // floor on each semi-axis, as a fraction of torso length
  maxRadiusFrac: 0.16, // ceiling, same units (keeps wild frames legible)
  highUncertaintyFrac: 0.11, // mean radius that maps to "fully red" for colouring
  highDepthJitter: 0.08, // normalized z residual std that maps to "fully red"
};

// Sample 2x2 covariance of a set of {x, y} points, plus their mean.
// n < 2 yields a zero covariance (no spread can be estimated). Kept for tests
// and reuse; buildPoseResult uses residual covariance (see below).
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

// Solve the small linear system A·x = b (Gaussian elimination, partial
// pivoting). A is n×n, b length n. Near-singular pivots yield a 0 coefficient
// (graceful degeneration) rather than NaN.
export function solveLinearSystem(A, b) {
  const n = b.length;
  // Work on copies so callers' arrays aren't mutated.
  const M = A.map((row) => row.slice());
  const v = b.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) continue; // singular column → leave 0
    [M[col], M[pivot]] = [M[pivot], M[col]];
    [v[col], v[pivot]] = [v[pivot], v[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (!f) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[col][c];
      v[r] -= f * v[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (Math.abs(M[i][i]) >= 1e-12) x[i] = v[i] / M[i][i];
  }
  return x;
}

// Residuals of a least-squares polynomial fit of `degree` to (ts, ys). The time
// axis is centred for numerical conditioning. degree 0 = subtract the mean,
// 1 = remove constant velocity, 2 = also remove acceleration.
export function polyResiduals(ts, ys, degree) {
  const n = ts.length;
  if (n === 0) return [];
  const tmean = ts.reduce((a, b) => a + b, 0) / n;
  const x = ts.map((t) => t - tmean);

  // Normal equations: (XᵀX)·c = Xᵀy, with X the Vandermonde matrix.
  const M = [];
  const v = [];
  for (let j = 0; j <= degree; j++) {
    let vj = 0;
    for (let i = 0; i < n; i++) vj += x[i] ** j * ys[i];
    v[j] = vj;
    M[j] = [];
    for (let k = 0; k <= degree; k++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += x[i] ** (j + k);
      M[j][k] = s;
    }
  }
  const c = solveLinearSystem(M, v);

  const res = new Array(n);
  for (let i = 0; i < n; i++) {
    let f = 0;
    for (let j = 0; j <= degree; j++) f += c[j] * x[i] ** j;
    res[i] = ys[i] - f;
  }
  return res;
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
//           0..1 with `visibility`/`presence`/`z` per point, or null when no
//           body was found)
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
    // visibility = P(not occluded); presence = P(in frame). Both default to 1
    // when the model doesn't supply them, so absent fields don't change output.
    const confidence = clamp((p.visibility ?? p.score ?? 1) * (p.presence ?? 1), 0, 1);
    keypoints.push({ jointName: name, x: cx, y: cy, confidence });

    // Gather this joint's samples over the temporal window.
    const ts = [];
    const xs = [];
    const ys = [];
    const zs = [];
    let zKnown = true;
    for (let j = i - o.window; j <= i + o.window; j++) {
      const f = frames[j];
      const q = f?.landmarks?.[index];
      if (!q) continue;
      ts.push(f.t ?? j); // seconds if available, else frame index
      xs.push(q.x * W);
      ys.push(q.y * H);
      if (q.z == null || !Number.isFinite(q.z)) zKnown = false;
      else zs.push(q.z);
    }
    // Need at least two samples to estimate spread; otherwise we fall back to
    // a keypoint with no ellipse (the brief's "point only" case).
    const n = ts.length;
    if (n < 2) continue;

    // Fit out smooth motion, then measure the wobble that remains. Cap the
    // degree so there's always at least one residual degree of freedom (else a
    // perfect fit would read as falsely certain).
    const degree = Math.max(0, Math.min(o.detrendDegree, n - 2));
    const dof = Math.max(1, n - (degree + 1));
    const rx = polyResiduals(ts, xs, degree);
    const ry = polyResiduals(ts, ys, degree);

    let cxx = 0;
    let cxy = 0;
    let cyy = 0;
    for (let k = 0; k < n; k++) {
      cxx += rx[k] * rx[k];
      cxy += rx[k] * ry[k];
      cyy += ry[k] * ry[k];
    }
    cxx /= dof;
    cxy /= dof;
    cyy /= dof;
    const { angle, major, minor } = eigenEllipse(cxx, cxy, cyy);

    // Depth jitter: residual wobble of z (normalized units), mapped to 0..1.
    let zNorm = 0;
    if (zKnown && zs.length === n) {
      const rz = polyResiduals(ts, zs, degree);
      let zvar = 0;
      for (const r of rz) zvar += r * r;
      zNorm = clamp(Math.sqrt(zvar / dof) / o.highDepthJitter, 0, 1);
    }

    // Confidence and depth jitter add to the radius (rather than scaling it), so
    // a still-but-unsure or occluded joint still grows a visible ellipse even
    // when its motion residual is ~0. Motion jitter then shapes it on top.
    const lowConf = clamp(1 - confidence, 0, 1);
    const addR = (o.visibilityWeight * lowConf + o.depthWeight * zNorm) * o.confDepthScaleFrac * torso;
    const majorR = clamp(o.kSigma * major + addR, minR, maxR);
    const minorR = clamp(o.kSigma * minor + addR, minR, maxR);

    const meanR = Math.sqrt(majorR * minorR);
    const geomScore = meanR / highR;
    // Colour by whichever signal is loudest: geometric size, low confidence, or
    // depth jitter — so any single strong cue turns the ellipse red.
    const uncertainty = clamp(Math.max(geomScore, 0.9 * lowConf, 0.8 * zNorm), 0, 1);

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
