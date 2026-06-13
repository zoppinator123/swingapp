// Justin Thomas "ghost" overlay: his extracted skeleton, time-warped to the
// player's swing checkpoints and scaled onto their body, plus per-bone
// grading of how far each limb segment is off his positions.
//
// Data comes from reference/justin-thomas/landmarks.json (written by the
// reference extraction step): a per-frame landmark sequence for one swing
// with its own checkpoint indices.

import { LM, mid } from "./metrics.js";

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
    return data;
  } catch {
    return null;
  }
}

const ANCHORS = ["address", "top", "impact", "finish"];

// Maps the player's frame index onto a ghost frame index by piecewise-linear
// interpolation between matching checkpoints, so both swings hit address,
// top, impact and finish at the same moment of the replay.
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

// Builds a transform from one ghost frame to pixel-space landmarks on the
// player's video: anchored at the player's address mid-hip, scaled by the
// ratio of torso lengths, and mirrored when the two face opposite ways
// (left-handed player, or camera on the other side).
export function createGhostAligner(ghost, userAddressLm, W, H) {
  const toUserPx = (p) => ({ x: p.x * W, y: p.y * H });
  const toGhostPx = ([x, y]) => ({ x: x * ghost.width, y: y * ghost.height });

  const gAddr = ghost.frames[ghost.phases.address];
  const gHip = mid(toGhostPx(gAddr[LM.L_HIP]), toGhostPx(gAddr[LM.R_HIP]));
  const gShoulder = mid(
    toGhostPx(gAddr[LM.L_SHOULDER]),
    toGhostPx(gAddr[LM.R_SHOULDER])
  );
  const uHip = mid(toUserPx(userAddressLm[LM.L_HIP]), toUserPx(userAddressLm[LM.R_HIP]));
  const uShoulder = mid(
    toUserPx(userAddressLm[LM.L_SHOULDER]),
    toUserPx(userAddressLm[LM.R_SHOULDER])
  );

  const gTorso = Math.hypot(gShoulder.x - gHip.x, gShoulder.y - gHip.y) || 1;
  const uTorso = Math.hypot(uShoulder.x - uHip.x, uShoulder.y - uHip.y) || 1;
  const scale = uTorso / gTorso;

  // Facing direction from the forward lean at address.
  const gDir = Math.sign(gShoulder.x - gHip.x) || 1;
  const uDir = Math.sign(uShoulder.x - uHip.x) || 1;
  const flip = gDir === uDir ? 1 : -1;

  return (frame) =>
    frame.map((p) => {
      const px = toGhostPx(p);
      return {
        x: uHip.x + (px.x - gHip.x) * flip * scale,
        y: uHip.y + (px.y - gHip.y) * scale,
      };
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
