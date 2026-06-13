// Justin Thomas "ghost" overlay: his extracted skeleton, time-warped to the
// player's swing checkpoints and scaled onto their body, plus per-bone
// grading of how far each limb segment is off his positions.
//
// Data comes from reference/justin-thomas/landmarks.json (written by the
// reference extraction step): a per-frame landmark sequence for one swing
// with its own checkpoint indices.

import { LM } from "./metrics.js";

const GHOST_URL = "reference/justin-thomas/landmarks.json";

// Bone segments to draw/grade, as landmark index pairs. Kept in sync with
// the skeleton drawn in overlay.js.
export const BONES = [
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_ELBOW],
  [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW],
  [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, LM.L_HIP],
  [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.R_HIP],
  [LM.L_HIP, LM.L_KNEE],
  [LM.L_KNEE, LM.L_ANKLE],
  [LM.R_HIP, LM.R_KNEE],
  [LM.R_KNEE, LM.R_ANKLE],
];

// Allowed deviation (degrees) per bone before it grades red. Arms get more
// slack than the body: the checkpoint time-warp aligns address/top/impact
// exactly, but between checkpoints small tempo differences move the fast
// segments (forearms especially) a long way without meaning a flaw.
export const BONE_TOLERANCE = [
  25, // shoulder line
  30, 40, // left upper arm, forearm
  30, 40, // right upper arm, forearm
  18, 18, // flanks (shoulder-hip)
  25, // hip line
  18, 18, // left thigh, shin
  18, 18, // right thigh, shin
];

// Loads the ghost data when it exists and matches the camera view.
export async function loadGhost(view) {
  try {
    const res = await fetch(GHOST_URL, { cache: "no-cache" });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.view !== view || !data.frames?.length || !data.phases) return null;
    // Guard against a partial/malformed export: the address frame must carry
    // all 33 landmark rows the aligner and time-warp index into.
    const addr = data.frames[data.phases.address];
    if (!Array.isArray(addr) || addr.length < 33) return null;
    return data;
  } catch {
    return null;
  }
}

const ANCHORS = ["address", "top", "impact", "finish"];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function smooth(vals, radius = 2) {
  return vals.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (vals[j] != null) {
        sum += vals[j];
        n++;
      }
    }
    return n ? sum / n : 0;
  });
}

// Maps the player's frame index onto a ghost frame index so both swings sit
// at the same point of the motion. Within address→top and top→impact the
// match follows the fraction of wrist travel (so an even backswing tempo on
// one side tracks an uneven one on the other); impact→finish, where wrist
// height isn't monotonic, interpolates linearly. Checkpoints always map to
// checkpoints.
export function createGhostTimeWarp(ghost, userFrames, userPhases) {
  const rawUy = userFrames.map((f) =>
    f.landmarks ? (f.landmarks[LM.L_WRIST].y + f.landmarks[LM.R_WRIST].y) / 2 : null
  );
  let last = rawUy.find((v) => v != null) ?? 0;
  const uy = smooth(rawUy.map((v) => (v != null ? (last = v) : last)));
  const gy = smooth(ghost.frames.map((f) => (f[LM.L_WRIST][1] + f[LM.R_WRIST][1]) / 2));

  const u = ANCHORS.map((p) => userPhases[p]);
  const g = ANCHORS.map((p) => ghost.phases[p]);

  // While the user is hand-correcting checkpoints they can be momentarily
  // out of order; fall back to the simple clamped mapping until they're not.
  if (u.some((v, k) => k > 0 && v <= u[k - 1])) {
    return (i) => ghostFrameIndex(ghost, userPhases, i);
  }

  return (i) => {
    if (i <= u[0]) return g[0];
    for (let k = 0; k + 1 < ANCHORS.length; k++) {
      if (i > u[k + 1]) continue;
      if (i === u[k + 1]) return g[k + 1];
      const [u0, u1, g0, g1] = [u[k], u[k + 1], g[k], g[k + 1]];
      const uSpan = uy[u1] - uy[u0];
      const gSpan = gy[g1] - gy[g0];
      if (k < 2 && Math.abs(uSpan) > 1e-4 && Math.abs(gSpan) > 1e-4) {
        const p = clamp01((uy[i] - uy[u0]) / uSpan);
        for (let j = g0; j <= g1; j++) {
          if (clamp01((gy[j] - gy[g0]) / gSpan) >= p) return j;
        }
        return g1;
      }
      const f = (i - u0) / Math.max(1, u1 - u0);
      return Math.round(g0 + f * (g1 - g0));
    }
    return g[g.length - 1];
  };
}

// Linear checkpoint-to-checkpoint mapping; kept as the simple fallback used
// when there's no wrist series to derive progress from.
export function ghostFrameIndex(ghost, userPhases, i) {
  const u = ANCHORS.map((p) => userPhases[p]);
  const g = ANCHORS.map((p) => ghost.phases[p]);
  if (i <= u[0]) return g[0];
  for (let k = 0; k + 1 < ANCHORS.length; k++) {
    if (i <= u[k + 1]) {
      const f = (i - u[k]) / Math.max(1, u[k + 1] - u[k]);
      return Math.round(g[k] + f * (g[k + 1] - g[k]));
    }
  }
  return g[g.length - 1];
}

// Landmarks used to fit the ghost onto the player: the stable frame of the
// body at address. Head and arms are excluded — grip style and head position
// vary too much between players to anchor on.
const FIT_POINTS = [
  LM.L_SHOULDER,
  LM.R_SHOULDER,
  LM.L_HIP,
  LM.R_HIP,
  LM.L_KNEE,
  LM.R_KNEE,
  LM.L_ANKLE,
  LM.R_ANKLE,
];

// Least-squares fit of user ≈ scale * ghost + offset (uniform scale, no
// rotation — the ground plane must stay level). Returns the transform and
// its residual error so the caller can compare mirrored/unmirrored fits.
function fitSimilarity(ghostPts, userPts) {
  const n = ghostPts.length;
  let gx = 0, gy = 0, ux = 0, uy = 0;
  for (let i = 0; i < n; i++) {
    gx += ghostPts[i].x; gy += ghostPts[i].y;
    ux += userPts[i].x; uy += userPts[i].y;
  }
  gx /= n; gy /= n; ux /= n; uy /= n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dgx = ghostPts[i].x - gx, dgy = ghostPts[i].y - gy;
    num += dgx * (userPts[i].x - ux) + dgy * (userPts[i].y - uy);
    den += dgx * dgx + dgy * dgy;
  }
  const s = den ? num / den : 1;
  const tx = ux - s * gx;
  const ty = uy - s * gy;

  let err = 0;
  for (let i = 0; i < n; i++) {
    err += Math.hypot(
      s * ghostPts[i].x + tx - userPts[i].x,
      s * ghostPts[i].y + ty - userPts[i].y
    );
  }
  return { s, tx, ty, err };
}

// Builds a transform from one ghost frame to pixel-space landmarks on the
// player's video: a least-squares fit of the ghost's address skeleton onto
// the player's (shoulders/hips/knees/ankles), tried both plain and mirrored
// (left-handed player, or camera on the other side) — whichever fits better.
export function createGhostAligner(ghost, userAddressLm, W, H) {
  const toUserPx = (p) => ({ x: p.x * W, y: p.y * H });
  const toGhostPx = ([x, y]) => ({ x: x * ghost.width, y: y * ghost.height });

  const gAddr = ghost.frames[ghost.phases.address];
  const gPts = FIT_POINTS.map((i) => toGhostPx(gAddr[i]));
  const uPts = FIT_POINTS.map((i) => toUserPx(userAddressLm[i]));

  const plain = fitSimilarity(gPts, uPts);
  const mirrored = fitSimilarity(gPts.map((p) => ({ x: -p.x, y: p.y })), uPts);
  const flip = mirrored.err < plain.err ? -1 : 1;
  const { s, tx, ty } = flip < 0 ? mirrored : plain;
  if (!Number.isFinite(s) || s <= 0) return null;

  return (frame) =>
    frame.map((p) => {
      const px = toGhostPx(p);
      return { x: s * flip * px.x + tx, y: s * px.y + ty };
    });
}

const segmentAngle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);

// Per-bone deviation between two pixel-space skeletons, in degrees (0-180).
export function boneDeviations(userPx, ghostPx) {
  return BONES.map(([i, j]) => {
    let d =
      Math.abs(segmentAngle(userPx[i], userPx[j]) - segmentAngle(ghostPx[i], ghostPx[j])) *
      (180 / Math.PI);
    if (d > 180) d = 360 - d;
    return d;
  });
}
