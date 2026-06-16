"""Run RF-DETR keypoints inference and produce a unified ``PoseResult``.

Because RF-DETR emits only ``(x, y, visibility)`` per joint (no covariance),
this wrapper *derives* the uncertainty ellipses:

* **single frame** → an isotropic ellipse sized from the joint's confidence
  (lower confidence ⇒ larger circle).
* **video / streaming** → when fed frames in sequence, a trailing window of
  recent positions per joint yields a real 2x2 covariance ellipse (the causal
  analogue of the centred window used in ``js/uncertainty.js``), inflated where
  confidence is low.

Joints missing from a detection fall back to point-only (no ellipse).
"""

from __future__ import annotations

import math
from collections import defaultdict, deque
from typing import TYPE_CHECKING, Any

from ..pose import (
    COCO_KEYPOINTS,
    Keypoint,
    PoseResult,
    UncertaintyEllipse,
    ellipse_from_confidence,
    ellipse_from_window,
)
from .loader import RFDETRUnavailable, load_rf_detr_model

if TYPE_CHECKING:
    import numpy as np


class RFDETRPoseModel:
    """``PoseModel`` implementation backed by RF-DETR Keypoints.

    Maintains an internal per-joint position history so that, when called frame
    by frame on a video, ellipses reflect temporal jitter. Set
    ``temporal_window=0`` to force confidence-only ellipses.
    """

    def __init__(
        self,
        weights: str | None = None,
        *,
        confidence_threshold: float = 0.3,
        keypoint_names: tuple[str, ...] = COCO_KEYPOINTS,
        temporal_window: int = 5,
        **loader_kwargs: Any,
    ) -> None:
        # Raises RFDETRUnavailable if the package/entry point is missing — the
        # CLI catches this and falls back to the synthetic backend.
        self.model = load_rf_detr_model(weights, **loader_kwargs)
        self.confidence_threshold = confidence_threshold
        self.keypoint_names = keypoint_names
        self.temporal_window = max(0, temporal_window)
        self._history: dict[str, deque[tuple[float, float]]] = defaultdict(
            lambda: deque(maxlen=self.temporal_window or 1)
        )

    # -- public API -------------------------------------------------------- #

    def predict(self, frame: "np.ndarray") -> PoseResult:
        h, w = int(frame.shape[0]), int(frame.shape[1])
        raw = self.model.predict(frame, threshold=self.confidence_threshold) \
            if _accepts_threshold(self.model) else self.model.predict(frame)
        keypoints = self._extract_keypoints(raw, w, h)
        return self._assemble(keypoints, w, h)

    def reset(self) -> None:
        """Clear the temporal history (call between independent clips)."""
        self._history.clear()

    # -- internals --------------------------------------------------------- #

    def _assemble(self, keypoints: list[Keypoint], w: int, h: int) -> PoseResult:
        result = PoseResult(frame_width=w, frame_height=h)
        scale = self._torso_scale(keypoints, h)

        for kp in keypoints:
            result.keypoints.append(kp)
            if self.temporal_window:
                hist = self._history[kp.joint_name]
                hist.append((kp.x, kp.y))
                ellipse = ellipse_from_window(
                    kp.joint_name, kp.x, kp.y, list(hist), kp.confidence, scale=scale
                )
                if ellipse is not None:
                    result.ellipses.append(ellipse)
                    continue  # got a covariance ellipse; done with this joint
            # Single-frame fallback (also used until the window fills).
            result.ellipses.append(
                ellipse_from_confidence(kp.joint_name, kp.x, kp.y, kp.confidence, scale=scale)
            )
        return result

    @staticmethod
    def _torso_scale(keypoints: list[Keypoint], h: int) -> float:
        by_name = {k.joint_name: k for k in keypoints}

        def mid(a: str, b: str):
            pa, pb = by_name.get(a), by_name.get(b)
            if pa and pb:
                return ((pa.x + pb.x) / 2, (pa.y + pb.y) / 2)
            return None

        sh, hip = mid("left_shoulder", "right_shoulder"), mid("left_hip", "right_hip")
        if sh and hip:
            length = math.hypot(sh[0] - hip[0], sh[1] - hip[1])
            if length > 1:
                return length
        return 0.30 * h  # sensible default when the torso isn't visible

    def _extract_keypoints(self, raw: Any, w: int, h: int) -> list[Keypoint]:
        """Parse RF-DETR / supervision output into Keypoints (highest-conf person).

        Handles a few shapes since the API is still settling:
        * supervision ``KeyPoints`` (``.xy`` (N, K, 2), ``.confidence`` (N, K))
        * an object with ``.keypoints`` / ``.keypoints_confidence`` arrays
        * a raw (K, 3) array of (x, y, visibility)
        """

        xy, conf = _coerce_keypoint_arrays(raw)
        if xy is None:
            return []

        # Pick the most confident instance when several are present.
        if len(xy.shape) == 3:
            if conf is not None and len(conf):
                idx = int(conf.mean(axis=1).argmax())
            else:
                idx = 0
            xy = xy[idx]
            conf = conf[idx] if conf is not None else None

        out: list[Keypoint] = []
        for i, (x, y) in enumerate(xy[: len(self.keypoint_names)]):
            c = float(conf[i]) if conf is not None and i < len(conf) else 1.0
            if c < self.confidence_threshold:
                continue  # drop low-confidence joints (point-only handled upstream)
            out.append(Keypoint(self.keypoint_names[i], float(x), float(y), c))
        return out


def _accepts_threshold(model: Any) -> bool:
    try:
        import inspect

        sig = inspect.signature(model.predict)
        return "threshold" in sig.parameters
    except (TypeError, ValueError):  # builtins / C-ext without a signature
        return False


def _coerce_keypoint_arrays(raw: Any):
    """Return (xy, conf) numpy arrays from a variety of result shapes, or (None, None)."""

    try:
        import numpy as np
    except ImportError:  # pragma: no cover - numpy required for real inference
        return None, None

    # supervision KeyPoints
    if hasattr(raw, "xy"):
        xy = np.asarray(raw.xy, dtype=float)
        conf = np.asarray(raw.confidence, dtype=float) if getattr(raw, "confidence", None) is not None else None
        return xy, conf

    # object exposing keypoints / keypoints_confidence
    if hasattr(raw, "keypoints"):
        kps = np.asarray(raw.keypoints, dtype=float)
        conf = getattr(raw, "keypoints_confidence", None)
        conf = np.asarray(conf, dtype=float) if conf is not None else None
        if kps.shape[-1] == 3 and conf is None:  # (..., K, 3) = x,y,vis
            conf = kps[..., 2]
            kps = kps[..., :2]
        return kps, conf

    # raw array
    arr = np.asarray(raw, dtype=float)
    if arr.ndim >= 2 and arr.shape[-1] == 3:
        return arr[..., :2], arr[..., 2]
    if arr.ndim >= 2 and arr.shape[-1] == 2:
        return arr, None
    return None, None


__all__ = ["RFDETRPoseModel", "RFDETRUnavailable", "UncertaintyEllipse"]
