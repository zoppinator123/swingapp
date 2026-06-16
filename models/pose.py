"""Unified pose-model interface for the swing app (offline/Python pipeline).

This is the Python-side counterpart to the in-browser pose pipeline. The live
app runs MediaPipe BlazePose in the browser (``js/pose.js``) and derives
uncertainty ellipses in ``js/uncertainty.js``; this module mirrors those data
structures so an offline tool can produce the same ``PoseResult`` shape.

Reality check on uncertainty ellipses
--------------------------------------
The original brief assumed RF-DETR Keypoints predicts a per-joint 2D
uncertainty *ellipse* (covariance). It does not: RF-DETR's keypoint head emits
only ``(x, y, visibility)`` per joint — the same information the existing
MediaPipe model already provides. So there is no covariance to read out of the
network. We instead *derive* uncertainty two ways, exactly as the JS app does:

* **confidence-based** — a single frame's visibility/score maps to an isotropic
  ellipse (lower confidence → bigger circle). Used when only one frame is seen.
* **temporal** — the 2x2 covariance of a joint's position over a short window
  of frames, inflated where visibility is low. This is the richer signal and
  matches ``js/uncertainty.js``.

Everything in this module is pure Python (no numpy/cv2 required) so it imports
and runs anywhere; heavyweight deps are confined to the backends that need them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol, Sequence, runtime_checkable

if TYPE_CHECKING:  # only for type hints; never required at runtime
    import numpy as np


# COCO-17 keypoint names, in canonical order. RF-DETR follows this convention,
# and the JS app's tracked joints are the subset of these with body landmarks.
COCO_KEYPOINTS: tuple[str, ...] = (
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
)


# --------------------------------------------------------------------------- #
# Data structures (mirror the dataclasses in the original brief and the JS app)
# --------------------------------------------------------------------------- #


@dataclass
class Keypoint:
    """A single detected joint in pixel coordinates."""

    joint_name: str
    x: float
    y: float
    confidence: float  # 0..1 (RF-DETR/BlazePose visibility, or model score)


@dataclass
class UncertaintyEllipse:
    """A per-joint 2D uncertainty ellipse, in pixel coordinates.

    ``width`` and ``height`` are full axis *lengths* (not radii); ``angle`` is
    the rotation of the major axis from the +x axis, in degrees. ``uncertainty``
    is a normalized 0..1 score (for colouring); larger ellipse ⇒ higher score.
    """

    joint_name: str
    cx: float
    cy: float
    width: float
    height: float
    angle: float
    uncertainty: float = 0.0


@dataclass
class PoseResult:
    """Unified output: keypoints plus their uncertainty ellipses."""

    keypoints: list[Keypoint] = field(default_factory=list)
    ellipses: list[UncertaintyEllipse] = field(default_factory=list)
    frame_width: int = 0
    frame_height: int = 0

    def keypoint(self, name: str) -> Keypoint | None:
        return next((k for k in self.keypoints if k.joint_name == name), None)

    def ellipse(self, name: str) -> UncertaintyEllipse | None:
        return next((e for e in self.ellipses if e.joint_name == name), None)


# --------------------------------------------------------------------------- #
# Model protocol + factory
# --------------------------------------------------------------------------- #


@runtime_checkable
class PoseModel(Protocol):
    """A pose estimator that returns keypoints + uncertainty ellipses."""

    def predict(self, frame: "np.ndarray") -> PoseResult:
        """Run pose estimation on a single BGR/RGB frame and return a PoseResult."""
        ...


# Backend name → ("module", "ClassName"). Imported lazily so that selecting one
# backend never drags in another backend's heavy dependencies.
_BACKENDS: dict[str, tuple[str, str]] = {
    "rf_detr": ("models.rf_detr.inference", "RFDETRPoseModel"),
    # The pre-RF-DETR estimator. In the browser that's MediaPipe; offline we
    # expose a dependency-free synthetic stand-in so the pipeline is runnable
    # end-to-end without model weights.
    "legacy": ("models.pose", "SyntheticPoseModel"),
    "yolo": ("models.pose", "SyntheticPoseModel"),
    "synthetic": ("models.pose", "SyntheticPoseModel"),
    "demo": ("models.pose", "SyntheticPoseModel"),
}

DEFAULT_MODEL = "rf_detr"


def get_pose_model(name: str = DEFAULT_MODEL, **kwargs) -> PoseModel:
    """Return a ready-to-use pose model by name.

    Supported names: ``"rf_detr"`` (default), ``"legacy"`` / ``"yolo"`` (the
    pre-existing estimator), and ``"synthetic"`` / ``"demo"`` (a dependency-free
    stand-in for runs without weights). Extra ``kwargs`` are forwarded to the
    backend constructor (e.g. ``weights=...`` for RF-DETR).
    """

    import importlib

    key = name.lower()
    if key not in _BACKENDS:
        raise ValueError(
            f"Unknown pose model {name!r}. Options: {', '.join(sorted(_BACKENDS))}."
        )
    module_name, class_name = _BACKENDS[key]
    module = importlib.import_module(module_name)
    return getattr(module, class_name)(**kwargs)


# --------------------------------------------------------------------------- #
# Shared ellipse math (pure Python; used by every backend)
# --------------------------------------------------------------------------- #


def covariance_2d(points: Sequence[tuple[float, float]]) -> tuple[float, float, float, float, float]:
    """Sample mean and 2x2 covariance of (x, y) points → (mx, my, cxx, cxy, cyy)."""

    n = len(points)
    if n == 0:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    if n < 2:
        return mx, my, 0.0, 0.0, 0.0
    cxx = cxy = cyy = 0.0
    for x, y in points:
        dx, dy = x - mx, y - my
        cxx += dx * dx
        cxy += dx * dy
        cyy += dy * dy
    d = n - 1
    return mx, my, cxx / d, cxy / d, cyy / d


def eigen_ellipse(cxx: float, cxy: float, cyy: float) -> tuple[float, float, float]:
    """Eigen-decompose a symmetric 2x2 covariance → (angle_deg, major_sd, minor_sd).

    ``major_sd``/``minor_sd`` are standard deviations (sqrt of eigenvalues) along
    the principal axes; ``angle_deg`` is the major-axis orientation from +x.
    """

    tr = cxx + cyy
    disc = math.sqrt(((cxx - cyy) / 2.0) ** 2 + cxy * cxy)
    lam_major = max(0.0, tr / 2.0 + disc)
    lam_minor = max(0.0, tr / 2.0 - disc)
    angle = 0.5 * math.degrees(math.atan2(2.0 * cxy, cxx - cyy))
    return angle, math.sqrt(lam_major), math.sqrt(lam_minor)


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def ellipse_from_confidence(
    name: str,
    cx: float,
    cy: float,
    confidence: float,
    *,
    scale: float,
    min_radius_frac: float = 0.012,
    max_radius_frac: float = 0.16,
) -> UncertaintyEllipse:
    """Build an isotropic ellipse from a single-frame confidence.

    ``scale`` is a reference length in pixels (e.g. torso length). Lower
    confidence ⇒ larger circle. This is the single-frame fallback for RF-DETR,
    which gives confidence but no covariance.
    """

    u = _clamp(1.0 - confidence, 0.0, 1.0)
    radius = _clamp((min_radius_frac + (max_radius_frac - min_radius_frac) * u) * scale,
                    min_radius_frac * scale, max_radius_frac * scale)
    return UncertaintyEllipse(
        joint_name=name, cx=cx, cy=cy,
        width=2 * radius, height=2 * radius, angle=0.0, uncertainty=u,
    )


def ellipse_from_window(
    name: str,
    cx: float,
    cy: float,
    points: Sequence[tuple[float, float]],
    confidence: float,
    *,
    scale: float,
    k_sigma: float = 2.4,
    visibility_inflation: float = 1.6,
    min_radius_frac: float = 0.012,
    max_radius_frac: float = 0.16,
    high_uncertainty_frac: float = 0.11,
) -> UncertaintyEllipse | None:
    """Build a covariance ellipse from a joint's positions over a time window.

    Mirrors ``buildPoseResult`` in ``js/uncertainty.js``. Returns ``None`` when
    there are too few samples to estimate spread (caller should fall back to a
    point-only keypoint).
    """

    if len(points) < 2:
        return None
    _mx, _my, cxx, cxy, cyy = covariance_2d(points)
    angle, major_sd, minor_sd = eigen_ellipse(cxx, cxy, cyy)

    inflate = 1.0 + visibility_inflation * _clamp(1.0 - confidence, 0.0, 1.0)
    min_r, max_r = min_radius_frac * scale, max_radius_frac * scale
    major_r = _clamp(k_sigma * major_sd * inflate, min_r, max_r)
    minor_r = _clamp(k_sigma * minor_sd * inflate, min_r, max_r)
    mean_r = math.sqrt(major_r * minor_r)
    uncertainty = _clamp(mean_r / (high_uncertainty_frac * scale), 0.0, 1.0)

    return UncertaintyEllipse(
        joint_name=name, cx=cx, cy=cy,
        width=2 * major_r, height=2 * minor_r, angle=angle, uncertainty=uncertainty,
    )


# --------------------------------------------------------------------------- #
# Synthetic backend — runs with zero model weights / heavy deps
# --------------------------------------------------------------------------- #


class SyntheticPoseModel:
    """A deterministic, dependency-free pose model for demos and tests.

    It fabricates a plausible standing skeleton scaled to the frame and injects
    confidence/jitter so the visualization pipeline can be exercised end-to-end
    without RF-DETR weights. It does **not** look at image content. Use it to
    verify drawing and the ``PoseResult`` contract, not for real analysis.
    """

    # Fractional (x, y) layout of COCO joints for an upright figure.
    _LAYOUT: dict[str, tuple[float, float]] = {
        "nose": (0.50, 0.12),
        "left_eye": (0.48, 0.11), "right_eye": (0.52, 0.11),
        "left_ear": (0.46, 0.12), "right_ear": (0.54, 0.12),
        "left_shoulder": (0.43, 0.27), "right_shoulder": (0.57, 0.27),
        "left_elbow": (0.39, 0.42), "right_elbow": (0.61, 0.42),
        "left_wrist": (0.37, 0.56), "right_wrist": (0.63, 0.56),
        "left_hip": (0.46, 0.56), "right_hip": (0.54, 0.56),
        "left_knee": (0.45, 0.76), "right_knee": (0.55, 0.76),
        "left_ankle": (0.44, 0.95), "right_ankle": (0.56, 0.95),
    }

    def __init__(self, seed: float = 0.0, jitter: float = 0.02, **_kwargs) -> None:
        self.seed = float(seed)
        self.jitter = float(jitter)
        self._t = 0  # advances each predict() so successive frames differ

    def _rng(self, salt: float) -> float:
        # Deterministic pseudo-random in [-1, 1].
        v = math.sin((self._t + self.seed) * 12.9898 + salt * 78.233) * 43758.5453
        return (v - math.floor(v)) * 2.0 - 1.0

    def predict(self, frame: "np.ndarray") -> PoseResult:
        h, w = (frame.shape[0], frame.shape[1]) if hasattr(frame, "shape") else (720, 1280)
        result = PoseResult(frame_width=w, frame_height=h)
        scale = 0.30 * h  # stand-in torso length

        for i, (name, (fx, fy)) in enumerate(self._LAYOUT.items()):
            # Wrists/ankles are the least certain; head/torso the most.
            noisy = name.endswith(("wrist", "ankle", "elbow"))
            amp = (self.jitter if noisy else self.jitter * 0.25)
            confidence = 0.55 if noisy else 0.95
            cx = (fx + amp * self._rng(i)) * w
            cy = (fy + amp * self._rng(i + 100)) * h
            result.keypoints.append(Keypoint(name, cx, cy, confidence))
            result.ellipses.append(
                ellipse_from_confidence(name, cx, cy, confidence, scale=scale)
            )
        self._t += 1
        return result
