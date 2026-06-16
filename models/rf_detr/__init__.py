"""RF-DETR Keypoints backend (offline).

``loader.py`` loads the model, ``inference.py`` runs it and produces a
``PoseResult``, and ``visualize.py`` draws the uncertainty ellipses.

Note: RF-DETR's keypoint head outputs only (x, y, visibility) — it does not
predict covariance/ellipses, and no pretrained pose weights ship with it. See
``docs/rf-detr-integration.md`` for what that means in practice.
"""

from .inference import RFDETRPoseModel  # noqa: F401
