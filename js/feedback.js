// Turns graded checkpoint metrics into plain-language coaching feedback.
// Each item: { title, text, good? } — a short name for the issue, then what
// happened, why it matters, and one thing to feel or practice.

import { computeMetrics, gradeMetrics } from "./metrics.js";

const deg = (v, digits = 0) => `${v.toFixed(digits)}°`;
const pct = (v) => `${Math.round(v * 100)}%`;

// Returns [{ title, text, good }] — one entry per finding.
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
      if (metrics.spineAngle < (range.min ?? 0)) {
        items.push({
          title: "Tilt forward more at setup",
          text:
            `You're standing too straight over the ball — ${deg(metrics.spineAngle)} of forward tilt, ` +
            `where the reference window is ${range.min}–${range.max}°. ` +
            `Push your hips back (like you're closing a car door behind you) and let your chest ` +
            `lean toward the ball until your arms hang straight down from your shoulders.`,
        });
      } else {
        items.push({
          title: "Stand a bit taller at setup",
          text:
            `You're bent over too far — ${deg(metrics.spineAngle)} of forward tilt, ` +
            `vs the ${range.min}–${range.max}° window. Keep the tilt, but get it by pushing ` +
            `your hips back: lift your chest and flatten your back instead of slumping your shoulders.`,
        });
      }
    }
    if (grades.kneeFlex === false) {
      const range = ref.phases.address.kneeFlex;
      if (metrics.kneeFlex > (range.max ?? 180)) {
        items.push({
          title: "Soften your knees at setup",
          text:
            `Your legs are nearly locked — knee angle ${deg(metrics.kneeFlex)}, where 180° is ` +
            `dead straight and the reference sets up at ${range.min}–${range.max}°. ` +
            `Sink into an athletic stance, like a shortstop waiting on a ground ball: ` +
            `a small knee bend lets your hips turn instead of your whole body lifting up.`,
        });
      } else {
        items.push({
          title: "Don't sit so deep at setup",
          text:
            `Your knees are bent more than the reference — knee angle ${deg(metrics.kneeFlex)} ` +
            `vs the ${range.min}–${range.max}° window (180° is dead straight). Stand up a touch: ` +
            `squatting too much at setup usually makes the body rise back up mid-swing.`,
        });
      }
    }
  }

  if (top?.grades.headSway === false) {
    items.push({
      title: "Keep your head steadier going back",
      text:
        `During the backswing your head slid sideways about ${pct(top.metrics.headSway)} of your ` +
        `torso length — the reference keeps it under ${pct(ref.phases.top.headSway.max)}. ` +
        `Feel like you're turning your chest around a head that stays put. A steady head makes it ` +
        `far easier to get the club back to the ball the same way every time.`,
    });
  }

  if (impact) {
    const { metrics, grades } = impact;
    if (grades.spineAngleDelta === false && metrics.spineAngleDelta < 0) {
      items.push({
        title: "You stand up through the ball (early extension)",
        text:
          `By impact you'd lost ${deg(Math.abs(metrics.spineAngleDelta), 1)} of the forward tilt ` +
          `you started with — your body straightened and your hips pushed toward the ball. ` +
          `This is the classic cause of thin shots and misses to the right. ` +
          `Practice feel: keep your back pockets against an imaginary wall behind you as you swing ` +
          `down, and keep your chest pointing at the ball through the strike.`,
      });
    } else if (grades.spineAngleDelta === false) {
      items.push({
        title: "You dip down into the ball",
        text:
          `Your forward tilt increased ${deg(metrics.spineAngleDelta, 1)} by impact — you're ` +
          `crouching into the strike, which usually shows up as heavy, fat contact. ` +
          `Feel taller through impact: let your lead leg straighten and your hips turn open ` +
          `instead of dropping your chest at the ball.`,
      });
    }
    if (grades.headSway === false) {
      items.push({
        title: "Quiet your head through the strike",
        text:
          `Your head had moved about ${pct(impact.metrics.headSway)} of your torso length by ` +
          `impact (reference: under ${pct(ref.phases.impact.headSway.max)}). ` +
          `Keep your eyes locked on the ball until well after contact — let your head come up ` +
          `with the follow-through, not before it.`,
      });
    }
    if (grades.hipSway === false) {
      items.push({
        title: "Turn your hips instead of sliding them",
        text:
          `Your hips slid sideways about ${pct(impact.metrics.hipSway)} of your torso length by ` +
          `impact (reference: under ${pct(ref.phases.impact.hipSway.max)}). A small bump toward ` +
          `the target is fine — after that, feel your belt buckle rotate to face the target ` +
          `rather than your whole body drifting.`,
      });
    }
  }

  if (items.length === 0) {
    items.push({
      title: "Posture checks out",
      text:
        "Your setup tilt, knee bend, and head stability are all inside the reference windows at " +
        "every checkpoint. Next thing to tighten: play the replay with the ghost on and watch " +
        "where your arms and body separate from the blue skeleton between checkpoints.",
      good: true,
    });
  }

  return items;
}
