"""Vendored copy of the undertone detector by V1sm4y (github.com/V1sm4y/Siv, undertone-detector/).

Only the measurement modules are included; see VENDORED.md. This __init__ replaces the upstream one,
which also imports the camera/live modules the sidecar does not use. Module files are unmodified.
"""

from .detect import AnalysisConfig, Thresholds, analyze_srgb, failure_hints, ita_class, warm_cool_position
from .warmcool import WarmCoolCalibration, evaluate_warm_cool, fit_warm_cool

__all__ = [
    "AnalysisConfig",
    "Thresholds",
    "WarmCoolCalibration",
    "analyze_srgb",
    "evaluate_warm_cool",
    "failure_hints",
    "fit_warm_cool",
    "ita_class",
    "warm_cool_position",
]
