# RF-DETR Keypoints integration — uncertainty ellipses

## TL;DR

The headline goal of the brief — **visualize per-joint pose uncertainty as
ellipses on swing replays** — is implemented and shipping in the actual app
(in-browser JavaScript). The mechanism is *not* RF-DETR, because two premises of
the original handoff turned out to be false:

1. **The app is not Python.** SwingApp is a static, no-build, in-browser web app
   (`index.html` + `js/*.js` + `style.css`, deployed on Vercel). Pose runs
   client-side via MediaPipe BlazePose (`js/pose.js`). There is no Python
   backend, no `models/` tree, no OpenCV — and a core promise is "your footage
   never leaves your device."
2. **RF-DETR does not emit uncertainty ellipses.** RF-DETR's keypoint head
   ([roboflow/rf-detr PR #521](https://github.com/roboflow/rf-detr/pull/521))
   follows YOLOv11 and outputs `(x, y, visibility)` per joint — the same shape
   MediaPipe already gives us. There is no covariance/ellipse output, and **no
   pretrained pose weights** exist (you must fine-tune on a keypoint dataset).

So "RF-DETR ellipses" can't be read off the network, and a server-side PyTorch
model can't plug into a browser-only app without adding a backend and breaking
the privacy guarantee. We therefore **derive** a genuine uncertainty signal and
render it in the app, and additionally ship a Python RF-DETR **scaffold** for
future/offline experimentation (per the "Both" decision).

## What ships in the app (primary deliverable)

Per-joint uncertainty ellipses drawn on the replay overlay, toggled by a new
**Uncertainty** switch on the video (next to **Ghost**).

- **Where the uncertainty comes from** (`js/uncertainty.js`): for each joint we
  take its position over a short window of frames (±3) and compute the 2x2
  covariance, then eigen-decompose it into a rotated ellipse (major/minor =
  standard deviations along the principal axes). We inflate the ellipse where
  MediaPipe reports low `visibility`, so an occluded-but-still joint still reads
  as uncertain. Intuition: a joint the tracker is unsure about jitters
  frame-to-frame and/or reports low visibility → a big red ellipse; a
  confidently tracked joint stays put → a tight amber one.
- **Rendering** (`js/overlay.js`, `drawUncertaintyEllipses`): semi-transparent,
  coloured along an amber→red ramp by a normalized uncertainty score (bigger ⇒
  redder ⇒ more opaque). The skeleton's joint dot sits in each ellipse centre.
- **Unified output**: `buildPoseResult(frames, i, W, H)` returns
  `{ keypoints, ellipses, frameWidth, frameHeight }`, matching the documented
  `PoseResult` shape, in pixel coordinates with COCO-style joint names.

This is fully client-side: no server, no new dependency, privacy intact.

### Files (JS)

| File | Role |
| --- | --- |
| `js/uncertainty.js` | Covariance/eigen math + `buildPoseResult` (compute) |
| `js/overlay.js` | `drawUncertaintyEllipses` + overlay hook (draw) |
| `js/main.js` | Toggle wiring; computes ellipses per frame on demand |
| `index.html`, `style.css` | Uncertainty toggle + legend swatch |

## What ships as scaffold (Python, offline/future)

A clean, typed implementation of the file tree from the brief, so a future
RF-DETR pipeline (or any pose model) has a home. The core is pure Python and
runs without heavy deps; real inference and video I/O require the optional
packages in `requirements-rfdetr.txt`.

| File | Role |
| --- | --- |
| `models/pose.py` | `Keypoint`/`UncertaintyEllipse`/`PoseResult` dataclasses, `PoseModel` protocol, `get_pose_model` factory, shared ellipse math, and a dependency-free `SyntheticPoseModel` |
| `models/rf_detr/loader.py` | Loads RF-DETR (defensive across versions); clear errors when unavailable |
| `models/rf_detr/inference.py` | `RFDETRPoseModel.predict()` → parses `(x,y,visibility)` and **derives** ellipses (confidence-based for a single frame, trailing-window covariance for video) |
| `models/rf_detr/visualize.py` | `draw_ellipses(frame, ellipses, ...)` with OpenCV (rotated, translucent, amber→red) |
| `lib/analysis/swing_analyzer.py` | Reference analyzer over any `PoseModel`; coarse checkpoint detection |
| `scripts/run_rf_detr.py` | CLI: render uncertainty ellipses onto a video |
| `config/models.yaml` | Backend + ellipse-tuning config |

### Honesty notes on the Python side

- `RFDETRPoseModel` synthesizes ellipses; it does **not** get them from the
  network (RF-DETR has none to give). The derivation matches the JS app.
- With no weights and/or no `rfdetr` install, the CLI **falls back to the
  synthetic backend** (with a warning) so it still produces a video with
  ellipses — useful for verifying the visualization, not for real analysis.
- This pipeline is **not wired into the live web app** and cannot be without
  introducing a backend (which would break the in-browser privacy model).

## Running

### The app (the real thing)

```sh
python3 -m http.server 8000   # serve the static site
# open http://localhost:8000, load a swing, Analyze, then toggle "Uncertainty"
```

### The Python CLI (offline experiment)

```sh
pip install -r requirements-rfdetr.txt        # optional deps
python scripts/run_rf_detr.py path/to/swing.mp4
# → path/to/swing_uncertainty.mp4

# Without RF-DETR weights it falls back to the synthetic backend:
python scripts/run_rf_detr.py path/to/swing.mp4 --model synthetic --every 2
```

```python
from models.pose import get_pose_model
from lib.analysis import SwingAnalyzer

analyzer = SwingAnalyzer(model="synthetic")        # or "rf_detr" with weights
analysis = analyzer.analyze_video("swing.mp4", every_n=3)
print(analysis.phases, analysis.frame_count)
```

## Making RF-DETR real later

1. Assemble/annotate a keypoint dataset (COCO-Pose format, or your own swing
   keypoints) and **fine-tune** an RF-DETR keypoint model.
2. Point `config/models.yaml` (or `--weights`) at the checkpoint; adjust
   `models/rf_detr/loader.py:_construct` to match your installed `rfdetr` API.
3. Run the CLI; the existing derivation will turn RF-DETR's `(x, y, visibility)`
   into the same ellipses the app draws.

Note this gives RF-DETR-quality **keypoints**, but the uncertainty ellipses are
still *derived* (jitter + confidence), because RF-DETR does not predict
covariance. True predicted covariance would require a model with an uncertainty
head (e.g. a probabilistic/heatmap-covariance pose model) — out of scope here.
