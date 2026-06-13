// Reference swing profiles: target ranges per camera view, per swing phase.
//
// The bundled defaults are placeholder ranges assembled from published PGA
// Tour posture/rotation norms. Once Justin Thomas footage is committed under
// reference/justin-thomas/, we extract his pose at each checkpoint and write
// reference/justin-thomas/profile.json with the same shape — it then
// overrides these defaults automatically.
//
// Range semantics: { min?, max? } per metric; see metrics.js for units.

const DEFAULTS = {
  "down-the-line": {
    name: "Tour baseline (placeholder — commit JT footage to replace)",
    phases: {
      address: {
        spineAngle: { min: 28, max: 45 },
        kneeFlex: { min: 148, max: 174 },
      },
      top: {
        headSway: { max: 0.18 },
        spineAngleDelta: { min: -8, max: 8 },
        // Depth-estimated shoulder turn (relative to address). From down-the-
        // line the hip line is too foreshortened to read, so hip turn /
        // X-factor are graded only in the face-on view. The floor is forgiving
        // because the depth estimate varies with clip quality.
        shoulderTurn: { min: 70 },
      },
      impact: {
        // Losing more than ~6 degrees of forward bend at impact reads as
        // early extension (standing up through the ball).
        spineAngleDelta: { min: -6, max: 10 },
        headSway: { max: 0.22 },
      },
    },
  },
  "face-on": {
    name: "Tour baseline (placeholder — commit JT footage to replace)",
    phases: {
      address: {
        shoulderTilt: { min: 3, max: 18 },
        kneeFlex: { min: 148, max: 174 },
      },
      top: {
        headSway: { max: 0.25 },
        hipSway: { max: 0.18 },
        // Depth-estimated; wide bands since these are guides, not exact.
        shoulderTurn: { min: 60, max: 130 },
        hipTurn: { min: 20, max: 75 },
        xFactor: { min: 20, max: 80 },
      },
      impact: {
        headSway: { max: 0.25 },
        hipSway: { max: 0.4 },
      },
    },
  },
};

export async function loadReference(view) {
  try {
    const res = await fetch("reference/justin-thomas/profile.json", {
      cache: "no-cache",
    });
    if (res.ok) {
      const profile = await res.json();
      if (profile[view]) return profile[view];
    }
  } catch {
    // No committed profile yet — use the bundled baseline.
  }
  return DEFAULTS[view];
}

export const PHASE_LABELS = {
  address: "Address",
  top: "Top of backswing",
  impact: "Impact",
  finish: "Finish",
};
