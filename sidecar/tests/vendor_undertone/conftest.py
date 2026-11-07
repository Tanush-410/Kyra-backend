# Upstream tests import the package as `undertone`; point that at the vendored copy.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kyra_sidecar" / "vendor"))

import pytest

# Upstream tests that need the camera module, which is not vendored.
NEEDS_CAMERA = {"test_clipping_is_measured_on_skin_only"}


def pytest_collection_modifyitems(items):
    for item in items:
        if item.name in NEEDS_CAMERA:
            item.add_marker(pytest.mark.skip(reason="needs undertone.camera, which is not vendored"))
