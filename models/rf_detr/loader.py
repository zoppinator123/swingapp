"""Load the RF-DETR Keypoints model.

Important caveats (see docs/rf-detr-integration.md):

* RF-DETR's keypoint/pose support (roboflow/rf-detr PR #521) follows YOLOv11's
  scheme and emits ``(x, y, visibility)`` per joint. There is **no covariance /
  uncertainty-ellipse output**.
* There are **no pretrained pose weights**. The base checkpoints are detection
  weights; the keypoint head must be fine-tuned on a keypoint dataset
  (e.g. COCO-Pose) before the model predicts anything useful. Pass that
  fine-tuned checkpoint via ``weights=...``.

The exact constructor for the pose variant depends on the installed ``rfdetr``
version, so this loader tries a few known entry points and raises a clear,
actionable error if none are available. Adjust ``_construct`` to match your
installed API if needed.
"""

from __future__ import annotations

from typing import Any


class RFDETRUnavailable(RuntimeError):
    """Raised when the RF-DETR pose model cannot be loaded."""


def load_rf_detr_model(
    weights: str | None = None,
    *,
    model_size: str = "nano",
    resolution: int | None = None,
    device: str | None = None,
    **kwargs: Any,
) -> Any:
    """Load and return a ready-to-use RF-DETR keypoints model.

    Parameters
    ----------
    weights:
        Path to fine-tuned keypoint weights. Required for real predictions —
        without it the keypoint head is untrained.
    model_size:
        ``"nano" | "small" | "medium" | "base"`` — selects the RF-DETR variant.
    resolution:
        Input resolution (must be divisible by 56 for RF-DETR). ``None`` keeps
        the model default.
    device:
        ``"cuda" | "cpu" | "mps"`` etc. ``None`` lets the library decide.

    Returns the underlying ``rfdetr`` model object. Raises ``RFDETRUnavailable``
    if the package isn't installed or no pose entry point is found.
    """

    try:
        import rfdetr  # noqa: F401
    except ImportError as exc:  # pragma: no cover - depends on env
        raise RFDETRUnavailable(
            "The 'rfdetr' package is not installed. Install it with "
            "`pip install rfdetr` (and a fine-tuned pose checkpoint), then retry. "
            "See docs/rf-detr-integration.md."
        ) from exc

    model = _construct(rfdetr, model_size=model_size, weights=weights,
                       resolution=resolution, device=device, **kwargs)
    if model is None:  # pragma: no cover - depends on env/version
        raise RFDETRUnavailable(
            "Couldn't find an RF-DETR keypoints/pose entry point in the installed "
            "'rfdetr' version. Keypoint support is recent (PR #521); upgrade with "
            "`pip install -U rfdetr` and/or adapt models/rf_detr/loader.py:_construct "
            "to your installed API."
        )
    return model


def _construct(rfdetr_mod, *, model_size: str, weights: str | None,
               resolution: int | None, device: str | None, **kwargs):  # pragma: no cover
    """Best-effort construction across rfdetr versions.

    Tries known class names for the pose/keypoints variant. Returns the model,
    or ``None`` if no suitable entry point exists. This is intentionally
    defensive because the pose API is new and still moving.
    """

    size = model_size.capitalize()  # nano -> Nano
    init_kwargs: dict[str, Any] = {}
    if weights:
        init_kwargs["pretrain_weights"] = weights
    if resolution:
        init_kwargs["resolution"] = resolution
    if device:
        init_kwargs["device"] = device
    init_kwargs.update(kwargs)

    # Candidate class names, most-specific first.
    candidates = [
        f"RFDETR{size}Pose",
        f"RFDETR{size}Keypoint",
        f"RFDETR{size}Keypoints",
        "RFDETRPose",
        "RFDETRKeypoint",
        "RFDETRKeypoints",
    ]
    for name in candidates:
        cls = getattr(rfdetr_mod, name, None)
        if cls is not None:
            return cls(**init_kwargs)

    # Some versions gate the task via a constructor argument instead.
    base = getattr(rfdetr_mod, f"RFDETR{size}", None) or getattr(rfdetr_mod, "RFDETR", None)
    if base is not None:
        try:
            return base(task="keypoint", **init_kwargs)
        except TypeError:
            try:
                return base(task="pose", **init_kwargs)
            except TypeError:
                return None
    return None
