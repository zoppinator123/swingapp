// Posture metrics computed from BlazePose landmarks (normalized image
// coordinates: x right, y down, 0..1). All comparisons use angles or
// fractions of torso length so they are independent of body size and
// distance from the camera.

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
  L_ANKLE: 27,
  R_ANKLE: 28,
};

export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Interior angle at vertex b, in degrees.
export function jointAngle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (!m) return 0;
  const cos = (v1.x * v2.x + v1.y * v2.y) / m;
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

export function midHip(lm) {
  return mid(lm[LM.L_HIP], lm[LM.R_HIP]);
}

export function midShoulder(lm) {
  return mid(lm[LM.L_SHOULDER], lm[LM.R_SHOULDER]);
}

export function torsoLength(lm) {
  return dist(midHip(lm), midShoulder(lm));
}

// Forward lean of the spine (mid-hip -> mid-shoulder) measured from
// vertical, in degrees. 0 = standing straight up.
export function spineAngle(lm) {
  const hip = midHip(lm);
  const sh = midShoulder(lm);
  return (Math.atan2(Math.abs(sh.x - hip.x), hip.y - sh.y) * 180) / Math.PI;
}

// Average hip-knee-ankle angle. 180 = legs locked straight; tour setup is
// roughly 150-172 depending on club.
export function kneeFlex(lm) {
  const left = jointAngle(lm[LM.L_HIP], lm[LM.L_KNEE], lm[LM.L_ANKLE]);
  const right = jointAngle(lm[LM.R_HIP], lm[LM.R_KNEE], lm[LM.R_ANKLE]);
  return (left + right) / 2;
}

// Tilt of the shoulder line from horizontal, in degrees (face-on view).
export function shoulderTilt(lm) {
  const l = lm[LM.L_SHOULDER];
  const r = lm[LM.R_SHOULDER];
  return (Math.atan2(Math.abs(l.y - r.y), Math.abs(l.x - r.x)) * 180) / Math.PI;
}

// Lateral drift of a point from its address position, as a fraction of
// torso length at address. Absolute value: direction depends on handedness
// and camera side, which the prototype doesn't disambiguate yet.
function lateralDrift(point, addressPoint, addressTorso) {
  return Math.abs(point.x - addressPoint.x) / addressTorso;
}

// All metrics for one frame. addressLm anchors the drift/delta metrics and
// may be null before analysis has identified the address frame.
export function computeMetrics(lm, addressLm) {
  const out = {
    spineAngle: spineAngle(lm),
    kneeFlex: kneeFlex(lm),
    shoulderTilt: shoulderTilt(lm),
  };

  if (addressLm) {
    const torso = torsoLength(addressLm) || 1;
    out.headSway = lateralDrift(lm[LM.NOSE], addressLm[LM.NOSE], torso);
    out.hipSway = lateralDrift(midHip(lm), midHip(addressLm), torso);
    out.spineAngleDelta = out.spineAngle - spineAngle(addressLm);
  }

  return out;
}

// Grades metrics against one phase of a reference profile. Returns
// { metricName: true|false } for every metric the profile constrains;
// metrics the profile doesn't mention are left ungraded.
export function gradeMetrics(metrics, phaseRef) {
  const grades = {};
  if (!phaseRef) return grades;
  for (const [name, range] of Object.entries(phaseRef)) {
    const v = metrics[name];
    if (v == null) continue;
    grades[name] =
      (range.min == null || v >= range.min) &&
      (range.max == null || v <= range.max);
  }
  return grades;
}

export const METRIC_LABELS = {
  spineAngle: "Spine angle (° from vertical)",
  spineAngleDelta: "Spine angle change vs address (°)",
  kneeFlex: "Knee flex (° hip-knee-ankle)",
  shoulderTilt: "Shoulder tilt (° from horizontal)",
  headSway: "Head sway (× torso length)",
  hipSway: "Hip sway (× torso length)",
};
