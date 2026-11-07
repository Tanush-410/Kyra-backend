# Vendored: undertone detector

- Source: https://github.com/V1sm4y/Siv/tree/main/undertone-detector
- Author: V1sm4y
- Upstream commit: 9611065 ("Add per-undertone color palettes with hex swatches, olive palette, and styling
  advice; fix olive threshold and flash subtraction"). First vendored at 8cab8e5.
- Licence: MIT (declared in the upstream pyproject.toml; the repository has no LICENSE file)
- Vendored on: 2026-11-06

Included unmodified: color.py, features.py, detect.py, palette.py, warmcool.py, calibration.py,
demo.py (test fixture), data/palette.json, and the upstream tests for those modules
(tests/vendor_undertone/). Not included: camera.py, live.py, cli.py, __main__.py (the sidecar has
its own camera loop). __init__.py is replaced by a minimal one that does not import the camera module.

The sidecar feeds it MediaPipe face-mesh regions through the upstream `region_provider` hook
(see kyra_sidecar/undertone_adapter.py).

## SHA-256 of vendored files (to diff against future upstream versions)

```
b0b63ee2c96e74b767d5fd948a65355393407fa79e870c8925524020570b2ee5  color.py
3b66148c2751d7c930b5bcbb5064ffcd6ea67cae8c03cd842836994b64f6a7a3  features.py
6f9ca732ee32a1ea15fd54bd2f0dd7867df58875dc5b54345f3f94c17b3f6c82  detect.py
ad72cdd961d9d420e1686e4d14aa17899dc8347fbf71567cd63629be1de2281f  palette.py
f5d9f30bf51a8e8bfc04a7b3138566171814808fd0c2708117d955db3d3ef870  warmcool.py
453812039616309ce83dd2a935ba78a08b238f568290cce4afe352037fa0963f  calibration.py
dd964eeb1275b68c28505c3fb5f5ce30e172e59fcdac85216bd98c9a4fc3ebff  demo.py
c228d92697e14fbe64de1f2c66efd262e2b054f37a25f2619080f97cc12fce97  data/palette.json
```

## Update history

- 8cab8e5 → 9611065: detect.py (olive threshold 3.5 → 9.0 on b* − 1.25·a*; skin swatch hex and
  undertone statement; olive palette key and styling advice), palette.py (olive palette, hex/RGB in
  suggestions, `styling_recommendations`), data/palette.json (olive palette), and three upstream tests.
  The flash-subtraction fix in that commit is in live.py, which is not vendored.
  Unchanged: color.py, features.py, warmcool.py, calibration.py, demo.py.

One upstream test (`test_clipping_is_measured_on_skin_only`) is skipped because it imports the
camera module; see tests/vendor_undertone/conftest.py.
