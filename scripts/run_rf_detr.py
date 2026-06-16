#!/usr/bin/env python3
"""CLI: draw per-joint uncertainty ellipses onto a swing video.

    python scripts/run_rf_detr.py path/to/swing.mp4

Processes every Nth frame with the chosen pose model and writes an output video
with uncertainty ellipses drawn (amber = confident, red = uncertain).

If RF-DETR isn't installed / has no usable pose weights, this falls back to the
dependency-free synthetic backend (with a loud warning) so the pipeline still
produces a video — useful for verifying the visualization. Pass
``--model synthetic`` to request that backend explicitly, or ``--weights`` to
point at a fine-tuned RF-DETR keypoint checkpoint for real predictions.
"""

from __future__ import annotations

import argparse
import os
import sys

# Make the repo root importable when run as `python scripts/run_rf_detr.py`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.pose import get_pose_model  # noqa: E402
from models.rf_detr.loader import RFDETRUnavailable  # noqa: E402
from models.rf_detr.visualize import draw_ellipses  # noqa: E402


def build_model(name: str, weights: str | None):
    """Return (model, effective_name), falling back to synthetic if RF-DETR can't load."""

    try:
        model = get_pose_model(name, weights=weights) if name == "rf_detr" \
            else get_pose_model(name)
        return model, name
    except RFDETRUnavailable as exc:
        print(f"[warn] RF-DETR unavailable: {exc}", file=sys.stderr)
        print("[warn] Falling back to the synthetic backend (no real pose).", file=sys.stderr)
        return get_pose_model("synthetic"), "synthetic"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("video", help="Path to the input swing video.")
    parser.add_argument("--model", default="rf_detr",
                        help="Pose backend: rf_detr (default), legacy/yolo, synthetic.")
    parser.add_argument("--weights", default=None,
                        help="Fine-tuned RF-DETR keypoint checkpoint (required for real RF-DETR).")
    parser.add_argument("--every", type=int, default=3, metavar="N",
                        help="Process every Nth frame (default: 3).")
    parser.add_argument("--out", default=None, help="Output video path.")
    parser.add_argument("--max-frames", type=int, default=None,
                        help="Stop after this many processed frames.")
    parser.add_argument("--no-ellipses", action="store_true",
                        help="Draw only keypoints, no ellipses.")
    args = parser.parse_args(argv)

    try:
        import cv2
    except ImportError:
        print("error: OpenCV (cv2) is required. Install with `pip install opencv-python`.",
              file=sys.stderr)
        return 2

    if not os.path.exists(args.video):
        print(f"error: no such file: {args.video}", file=sys.stderr)
        return 2

    model, effective = build_model(args.model, args.weights)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"error: could not open video: {args.video}", file=sys.stderr)
        return 2

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    out_fps = max(1.0, src_fps / max(1, args.every))
    out_path = args.out or _default_out(args.video)

    writer = None
    processed = 0
    read = 0
    uncertainty_sum = 0.0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if read % args.every == 0:
                pose = model.predict(frame)
                ellipses = [] if args.no_ellipses else pose.ellipses
                rendered = draw_ellipses(
                    frame, ellipses, keypoints=pose.keypoints, draw_keypoints=True
                )
                if writer is None:
                    h, w = rendered.shape[:2]
                    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
                    writer = cv2.VideoWriter(out_path, fourcc, out_fps, (w, h))
                writer.write(rendered)
                processed += 1
                if pose.ellipses:
                    uncertainty_sum += sum(e.uncertainty for e in pose.ellipses) / len(pose.ellipses)
                if processed % 25 == 0:
                    print(f"  processed {processed} frames…")
                if args.max_frames and processed >= args.max_frames:
                    break
            read += 1
    finally:
        cap.release()
        if writer is not None:
            writer.release()

    if processed == 0:
        print("error: no frames were processed (empty or unreadable video).", file=sys.stderr)
        return 1

    mean_unc = uncertainty_sum / processed
    print(f"\nDone. Backend: {effective}.")
    print(f"  Processed {processed} frames (every {args.every}) → {out_path}")
    print(f"  Mean per-frame uncertainty: {mean_unc:.2f}")
    if effective == "synthetic":
        print("  NOTE: synthetic backend — ellipses are illustrative, not real pose.")
    return 0


def _default_out(video: str) -> str:
    base, _ext = os.path.splitext(video)
    return f"{base}_uncertainty.mp4"


if __name__ == "__main__":
    raise SystemExit(main())
