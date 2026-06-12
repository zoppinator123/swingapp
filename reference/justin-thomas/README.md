# Justin Thomas reference footage

Drop JT swing footage in this folder and the analyzer will use his measured
posture in place of the bundled tour-baseline ranges.

## What to commit

Either short video clips (preferred) or still frames:

**Clips** — one swing per file, 2–10 seconds, named by view:

```
dtl-driver-01.mp4        # down-the-line view
dtl-iron-01.mp4
face-on-driver-01.mp4    # face-on view
```

**Stills** — if clips are too large, screenshots at the key positions work:

```
dtl-address.jpg
dtl-top.jpg
dtl-impact.jpg
face-on-address.jpg
face-on-top.jpg
face-on-impact.jpg
```

Tips:

- Highest resolution and frame rate you can get; slow-mo broadcast footage is
  ideal.
- The view must be a clean down-the-line or face-on angle — oblique camera
  angles skew every measured value.
- Two or three swings per view lets us average out per-frame noise.

## What happens next

Once footage lands here, the extraction step runs the same pose pipeline on
it and writes `profile.json` in this folder, shaped like the defaults in
`js/reference.js`:

```json
{
  "down-the-line": {
    "name": "Justin Thomas (driver, DTL)",
    "phases": {
      "address": { "spineAngle": { "min": 36, "max": 42 } }
    }
  }
}
```

The app picks up `profile.json` automatically — no code change needed.

> Note: fine for personal use; if the app is ever distributed publicly,
> using a named player's likeness as the in-app benchmark needs a rights
> review.
