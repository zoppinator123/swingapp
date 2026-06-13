// Draws the analysis overlay on top of the video: skeleton (per-bone green/
// red when ghost comparison is active), the time-matched reference ghost,
// spine line (green inside the reference range, red outside), the dashed
// target wedge showing where the spine should be, and the head-stability box.

import { LM, midHip, midShoulder, torsoLength, spineAngle } from "./metrics.js";
import { BONES, BONE_TOLERANCE, boneDeviations } from "./ghost.js";

// Tuned for legibility over green-grass / sky footage; aligned to the app's
// palette (fairway / clay / bone / sky).
const GOOD = "#46C47E";
const BAD = "#E2693F";
const NEUTRAL = "rgba(243, 239, 230, 0.6)";
const GHOST = "rgba(125, 196, 255, 0.7)";

function toPx(p, W, H) {
  return { x: p.x * W, y: p.y * H };
}

function line(ctx, a, b, color, width, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

// boneColors: optional per-bone color array (indexed like BONES); bones
// without one fall back to neutral.
function drawSkeleton(ctx, lm, W, H, boneColors) {
  BONES.forEach(([i, j], k) => {
    const color = boneColors?.[k] ?? NEUTRAL;
    line(ctx, toPx(lm[i], W, H), toPx(lm[j], W, H), color, boneColors ? 4 : 3);
  });
  ctx.save();
  ctx.fillStyle = NEUTRAL;
  for (const i of Object.values(LM)) {
    const p = toPx(lm[i], W, H);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// The reference ghost skeleton, already in pixel space.
function drawGhost(ctx, ghostPx) {
  for (const [i, j] of BONES) {
    line(ctx, ghostPx[i], ghostPx[j], GHOST, 3, [7, 5]);
  }
  ctx.save();
  ctx.fillStyle = GHOST;
  for (const i of Object.values(LM)) {
    ctx.beginPath();
    ctx.arc(ghostPx[i].x, ghostPx[i].y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Dashed green lines anchored at the hips marking the min/max target spine
// angle, plus the player's actual spine line colored by whether it's inside.
function drawSpineGuide(ctx, lm, addressLm, range, W, H) {
  const hip = toPx(midHip(lm), W, H);
  const sh = toPx(midShoulder(lm), W, H);
  const len = Math.hypot(sh.x - hip.x, sh.y - hip.y);

  // Lean direction (toward the ball) taken from the address frame so the
  // wedge doesn't flip when the player rotates mid-swing.
  const ref = addressLm ?? lm;
  const dir = Math.sign(midShoulder(ref).x - midHip(ref).x) || 1;

  const wedgePoint = (deg) => ({
    x: hip.x + Math.sin((deg * Math.PI) / 180) * len * dir,
    y: hip.y - Math.cos((deg * Math.PI) / 180) * len,
  });

  let inRange = true;
  if (range) {
    line(ctx, hip, wedgePoint(range.min ?? 0), GOOD, 2, [8, 6]);
    line(ctx, hip, wedgePoint(range.max ?? 60), GOOD, 2, [8, 6]);
    const angle = spineAngle(lm);
    inRange =
      (range.min == null || angle >= range.min) &&
      (range.max == null || angle <= range.max);
  }

  line(ctx, hip, sh, range ? (inRange ? GOOD : BAD) : NEUTRAL, 5);
}

// Box around the address head position; the head should stay inside it
// through impact. Colored by whether the current nose position is inside.
function drawHeadBox(ctx, lm, addressLm, tolerance, W, H) {
  if (!addressLm || !tolerance) return;

  const torso = torsoLength(addressLm);
  const center = toPx(addressLm[LM.NOSE], W, H);
  const half = tolerance * torso * W;
  const nose = toPx(lm[LM.NOSE], W, H);

  const inside =
    Math.abs(nose.x - center.x) <= half &&
    Math.abs(nose.y - center.y) <= half * 1.4;

  ctx.save();
  ctx.strokeStyle = inside ? GOOD : BAD;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(center.x - half, center.y - half * 1.4, half * 2, half * 2.8);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = inside ? GOOD : BAD;
  ctx.beginPath();
  ctx.arc(nose.x, nose.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// options: { addressLm, spineRange, headTolerance, posturePhase, ghostLm } —
// the spine/head guides are suppressed after impact (posturePhase ===
// "done") since follow-through posture is intentionally different. ghostLm
// is the time-matched reference skeleton in pixel space; when present, the
// ghost is drawn under the player and every bone of the player's skeleton
// is colored by how far it deviates from the ghost's matching segment.
export function drawOverlay(ctx, W, H, lm, options = {}) {
  ctx.clearRect(0, 0, W, H);

  if (options.ghostLm) drawGhost(ctx, options.ghostLm);
  if (!lm) return;

  let boneColors = null;
  if (options.ghostLm) {
    const userPx = lm.map((p) => toPx(p, W, H));
    boneColors = boneDeviations(userPx, options.ghostLm).map((d, k) =>
      d <= BONE_TOLERANCE[k] ? GOOD : BAD
    );
  }

  drawSkeleton(ctx, lm, W, H, boneColors);

  const active = options.posturePhase !== "done";
  drawSpineGuide(ctx, lm, options.addressLm, active ? options.spineRange : null, W, H);
  if (active) {
    drawHeadBox(ctx, lm, options.addressLm, options.headTolerance, W, H);
  }
}
