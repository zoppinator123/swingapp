// Turns graded checkpoint metrics into plain-language coaching feedback.

import { computeMetrics, gradeMetrics } from "./metrics.js";

const fmt = (v, digits = 1) => v.toFixed(digits);

// Returns [{ text, good }] — one entry per finding, worst problems first.
export function buildFeedback(frames, phases, ref) {
  const items = [];
  const addressLm = frames[phases.address]?.landmarks;
  if (!addressLm || !ref) return items;

  const at = (phase) => {
    const lm = frames[phases[phase]]?.landmarks;
    if (!lm) return null;
    const metrics = computeMetrics(lm, addressLm);
    return { metrics, grades: gradeMetrics(metrics, ref.phases[phase]) };
  };

  const address = at("address");
  const top = at("top");
  const impact = at("impact");

  if (address) {
    const { metrics, grades } = address;
    if (grades.spineAngle === false) {
      const range = ref.phases.address.spineAngle;
      items.push({
        text:
          metrics.spineAngle < (range.min ?? 0)
            ? `Setup is too upright: ${fmt(metrics.spineAngle)}° of forward bend at address (target ${range.min}–${range.max}°). Tilt from the hips, not the waist.`
            : `Setup is too hunched: ${fmt(metrics.spineAngle)}° of forward bend at address (target ${range.min}–${range.max}°). Stand taller with a flatter back.`,
      });
    }
    if (grades.kneeFlex === false) {
      items.push({
        text: `Knee flex at address is outside the tour window (${fmt(metrics.kneeFlex, 0)}°, target ${ref.phases.address.kneeFlex.min}–${ref.phases.address.kneeFlex.max}°). Athletic, slightly flexed knees — not squatting, not locked.`,
      });
    }
  }

  if (top?.grades.headSway === false) {
    items.push({
      text: `Head sways ${fmt(top.metrics.headSway, 2)}× torso length off the ball at the top (target ≤ ${ref.phases.top.headSway.max}). Turn around your spine instead of sliding away from the target.`,
    });
  }

  if (impact) {
    const { metrics, grades } = impact;
    if (grades.spineAngleDelta === false && metrics.spineAngleDelta < 0) {
      items.push({
        text: `Early extension: you lost ${fmt(Math.abs(metrics.spineAngleDelta))}° of spine angle by impact. Keep your chest down through the ball — maintain the bend you set at address.`,
      });
    } else if (grades.spineAngleDelta === false) {
      items.push({
        text: `You're diving into the ball: spine angle increased ${fmt(metrics.spineAngleDelta)}° by impact. Stay tall through the strike.`,
      });
    }
    if (grades.headSway === false) {
      items.push({
        text: `Head moves ${fmt(impact.metrics.headSway, 2)}× torso length by impact. Quiet head through the hitting zone.`,
      });
    }
    if (grades.hipSway === false) {
      items.push({
        text: `Hip slide at impact is ${fmt(impact.metrics.hipSway, 2)}× torso length, outside the reference window. Rotate the hips open rather than sliding laterally.`,
      });
    }
  }

  if (items.length === 0) {
    items.push({
      text: "All tracked checkpoints are inside the reference windows. Posture looks solid — next step is comparing tempo and rotation once the Justin Thomas profile is loaded.",
      good: true,
    });
  }

  return items;
}
