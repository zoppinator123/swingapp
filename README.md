# SwingApp

A golf swing analyzer: record or upload a video of your swing and get visual
posture feedback — green/red guide lines on the replay showing where your body
should be, benchmarked against a tour reference profile (target: Justin
Thomas).

## Running the prototype

It's a static web app — no build step. From the repo root:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000> in a modern browser (Chrome recommended).
The pose model (~9 MB) is fetched from Google's CDN on first analysis and runs
entirely in your browser — your swing video never leaves your device.

## How to record a swing for analysis

- **Full body in frame** for the entire swing, tripod or propped phone.
- Pick one of the two standard views and select it in the app:
  - **Down the line** — camera behind you, looking toward the target.
  - **Face on** — camera directly in front of your chest.
- Slow-motion (120/240 fps) clips track noticeably better than normal speed.
- One swing per clip, with a second of stillness at address.

## What it does today

1. Extracts 33 body landmarks per frame with MediaPipe Pose (BlazePose).
2. Auto-detects swing checkpoints from the wrist trajectory: address, top of
   backswing, impact, finish.
3. Computes posture metrics (spine angle, knee flex, head/hip sway, shoulder
   tilt) as angles and torso-relative fractions, so body size and camera
   distance don't matter.
4. Grades each checkpoint against the reference profile and draws the
   overlay: skeleton, spine line (green in range / red out), dashed target
   wedge for spine angle, and a head-stability box.
5. Generates plain-language feedback (e.g. early extension, head sway).

## The Justin Thomas reference profile

The bundled ranges in `js/reference.js` are placeholder tour baselines. To
replace them with JT's actual numbers, commit his swing footage under
[`reference/justin-thomas/`](reference/justin-thomas/) — see the README there
for naming and formats. The extraction step will generate
`reference/justin-thomas/profile.json`, which the app loads automatically in
place of the defaults.

## Roadmap

- [x] Web prototype: upload → pose overlay → checkpoint grading → feedback
- [ ] Extract the Justin Thomas profile from committed footage
- [ ] Side-by-side ghost comparison (your frame vs JT at the same checkpoint)
- [ ] Rotation metrics (shoulder/hip turn, X-factor) and tempo (3:1 ratio)
- [ ] Manual checkpoint correction when auto-detection misses
- [ ] Native mobile app with in-app slow-mo capture and real-time feedback

## Known limitations

- Club and clubface are **not** tracked — body posture only. Club tracking
  needs a separate model and is deliberately out of scope for v1.
- Phase detection is heuristic; verify checkpoints with the timeline chips.
- Sway metrics use absolute lateral drift and don't yet distinguish toward /
  away from the target.
- The analyzed view must match the reference footage view (the app asks).
