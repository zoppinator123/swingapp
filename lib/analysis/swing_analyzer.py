"""Reference swing analyzer driven by the unified pose interface.

The production swing analysis lives in the browser (``js/metrics.js``,
``js/phases.js``, ``js/ghost.js``). This module is the Python-side analogue: it
shows how any ``PoseModel`` plugs into a frame-by-frame pipeline and keeps the
``PoseResult`` (keypoints + uncertainty ellipses) flowing through to metrics and
overlays. It is deliberately small — enough to prove the interface works and to
back the CLI test script — not a port of the full JS analysis.

``analyze_frames`` is pure Python (works with the synthetic backend and needs no
OpenCV); ``analyze_video`` adds OpenCV-based decoding.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Iterable

from models.pose import PoseModel, PoseResult, get_pose_model

if TYPE_CHECKING:
    import numpy as np


@dataclass
class SwingAnalysis:
    """Output of an analysis run: per-frame poses plus coarse swing checkpoints."""

    poses: list[PoseResult] = field(default_factory=list)
    phases: dict[str, int] = field(default_factory=dict)  # name -> frame index
    mean_uncertainty: list[float] = field(default_factory=list)  # per frame

    @property
    def frame_count(self) -> int:
        return len(self.poses)


class SwingAnalyzer:
    """Runs a ``PoseModel`` over frames and derives simple swing checkpoints."""

    def __init__(self, model: PoseModel | str = "rf_detr", **model_kwargs) -> None:
        self.model: PoseModel = (
            get_pose_model(model, **model_kwargs) if isinstance(model, str) else model
        )

    def analyze_frames(self, frames: Iterable["np.ndarray"]) -> SwingAnalysis:
        analysis = SwingAnalysis()
        for frame in frames:
            pose = self.model.predict(frame)
            analysis.poses.append(pose)
            analysis.mean_uncertainty.append(_mean_uncertainty(pose))
        analysis.phases = _detect_phases(analysis.poses)
        return analysis

    def analyze_video(self, path: str, *, every_n: int = 1, max_frames: int | None = None) -> SwingAnalysis:
        """Decode a video with OpenCV and analyze every ``every_n``-th frame."""

        import cv2

        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            raise FileNotFoundError(f"Could not open video: {path}")
        try:
            frames = _read_frames(cap, every_n=every_n, max_frames=max_frames)
            return self.analyze_frames(frames)
        finally:
            cap.release()


def _read_frames(cap, *, every_n: int, max_frames: int | None):
    i = produced = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % every_n == 0:
            yield frame
            produced += 1
            if max_frames is not None and produced >= max_frames:
                break
        i += 1


def _mean_uncertainty(pose: PoseResult) -> float:
    if not pose.ellipses:
        return 0.0
    return sum(e.uncertainty for e in pose.ellipses) / len(pose.ellipses)


def _mid_wrist_y(pose: PoseResult) -> float | None:
    lw, rw = pose.keypoint("left_wrist"), pose.keypoint("right_wrist")
    ys = [k.y for k in (lw, rw) if k is not None]
    return sum(ys) / len(ys) if ys else None


def _detect_phases(poses: list[PoseResult]) -> dict[str, int]:
    """Very coarse checkpoints from the wrist trajectory (image y grows downward).

    address = first frame with wrists; top = highest wrists (min y); impact =
    after the top, where wrists first return near the address height; finish =
    last frame. Heuristic — mirrors the spirit of js/phases.js, not its detail.
    """

    ys = [(_mid_wrist_y(p), i) for i, p in enumerate(poses)]
    valid = [(y, i) for y, i in ys if y is not None]
    if not valid:
        return {}

    address = valid[0][1]
    address_y = valid[0][0]
    top_y, top = min(valid, key=lambda t: t[0])

    impact = poses and len(poses) - 1
    for y, i in valid:
        if i > top and y >= address_y - 1e-6:
            impact = i
            break

    return {"address": address, "top": top, "impact": impact, "finish": valid[-1][1]}
