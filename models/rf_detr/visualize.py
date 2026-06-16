"""Draw per-joint uncertainty ellipses on a frame with OpenCV.

Mirrors the in-browser renderer (``js/overlay.js``): ellipses are drawn
semi-transparently, coloured along an amber→red ramp by their ``uncertainty``
score (larger/redder ⇒ more uncertain), with the keypoint dot on top in the
centre of each ellipse.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Iterable, Sequence

from ..pose import Keypoint, UncertaintyEllipse

if TYPE_CHECKING:
    import numpy as np

# Colour ramp endpoints in BGR (OpenCV order). Amber = confident, red = unsure.
_LOW_BGR = (75, 184, 232)   # amber  (#E8B84B)
_HIGH_BGR = (48, 64, 211)   # red    (#D34030)


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _color(u: float) -> tuple[int, int, int]:
    t = 0.0 if u < 0 else 1.0 if u > 1 else u
    return tuple(int(round(_lerp(_LOW_BGR[i], _HIGH_BGR[i], t))) for i in range(3))  # type: ignore[return-value]


def draw_ellipses(
    frame: "np.ndarray",
    ellipses: Sequence[UncertaintyEllipse],
    *,
    keypoints: Iterable[Keypoint] | None = None,
    draw_keypoints: bool = True,
) -> "np.ndarray":
    """Return a copy of ``frame`` with uncertainty ellipses (and optional dots) drawn.

    Each ellipse is filled with opacity scaled by uncertainty, then outlined.
    ``width``/``height`` are full axis lengths, so OpenCV's half-axis ``axes``
    argument is ``(width/2, height/2)``.
    """

    import cv2  # local import: OpenCV only needed for drawing
    import numpy as np

    out = frame.copy()
    overlay = frame.copy()  # filled ellipses go here, then we blend

    for e in ellipses:
        color = _color(e.uncertainty)
        center = (int(round(e.cx)), int(round(e.cy)))
        axes = (max(1, int(round(e.width / 2))), max(1, int(round(e.height / 2))))
        # Filled (for the translucent body) on the overlay, outline on the result.
        cv2.ellipse(overlay, center, axes, e.angle, 0, 360, color, thickness=-1, lineType=cv2.LINE_AA)
        cv2.ellipse(out, center, axes, e.angle, 0, 360, color, thickness=2, lineType=cv2.LINE_AA)

    if ellipses:
        # Opacity rises with the strongest ellipse on screen, capped for legibility.
        alpha = min(0.45, 0.18 + 0.3 * max((e.uncertainty for e in ellipses), default=0.0))
        cv2.addWeighted(overlay, alpha, out, 1 - alpha, 0, out)

    if draw_keypoints and keypoints is not None:
        for kp in keypoints:
            cv2.circle(out, (int(round(kp.x)), int(round(kp.y))), 4, (230, 239, 243), -1, lineType=cv2.LINE_AA)

    return out
