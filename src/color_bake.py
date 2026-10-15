"""Bake the ACES 1.0 SDR-video display view from OpenColorIO into .cube LUTs for ffmpeg.

Usage: python color_bake.py --check
       python color_bake.py <spec json>

spec: {"input": "acescg" | "lin_rec709" | "lin_rec2020" | "aces2065" | "applelog",
       "stops": exposure in stops, "size": 3D LUT size,
       "out3d": path of the 3D LUT, "out1d": path of the 1D display-encoding LUT}

The view is OCIO's built-in ACES 1.3 CG config, "ACES 1.0 - SDR Video" on "Rec.1886
Rec.709 - Display". It matches Maya 2026's default "ACES 1.0 SDR-video" on its Rec.1886 /
Rec.709 display exactly (after clamping to 0-1, as Maya does).

ffmpeg applies it in three steps, so the LUT only has to model smooth functions:
  1. shaper: scene-linear inputs are encoded with SMPTE ST 2084 / PQ by zscale (npl=100:
     linear 1.0 = 100 nits). Apple Log is already a log encoding and is used as is.
  2. 3D LUT (out3d): shaper code -> linear Rec.709 display light, NOT clamped and NOT
     gamma-encoded. Both the gamut clamp and the steep 1/2.4 power near black are kinks
     that a 3D grid blurs; keeping them out of it is what makes 65^3 accurate.
  3. 1D LUT (out1d): clamp to 0-1 and encode for a gamma 2.4 (BT.1886) display.
"""
import json
import sys

import numpy as np

CONFIG = "ocio://cg-config-v2.2.0_aces-v1.3_ocio-v2.4"
OUTPUT_TRANSFORM = "ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-VIDEO_1.0"
SPACES = {"acescg": "ACEScg", "lin_rec709": "Linear Rec.709 (sRGB)", "lin_rec2020": "Linear Rec.2020", "aces2065": "ACES2065-1"}
# CIE XYZ (D65) -> linear Rec.709, as in the config's Rec.1886 Rec.709 display
XYZ_TO_REC709 = [3.240969941905, -1.537383177570, -0.498610760293, 0, -0.969243636281, 1.875967501508, 0.041555057407, 0,
                 0.055630079697, -0.203976958889, 1.056971514243, 0, 0, 0, 0, 1]

# SMPTE ST 2084
M1, M2, C1, C2, C3 = 2610 / 16384, 2523 / 4096 * 128, 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32


def pq_to_linear(code):
    """PQ code value -> scene-linear, with linear 1.0 = 100 nits (zscale npl=100)."""
    p = np.power(np.clip(code, 0, 1), 1 / M2)
    nits = 10000 * np.power(np.maximum(p - C1, 0) / (C2 - C3 * p), 1 / M1)
    return nits / 100


# Apple Log (Apple Log Profile white paper) -> scene-linear Rec.2020
R0, RT, C, B, G, BETA = -0.05641088, 0.01, 47.28711236, 0.00964052, 0.08550479, 0.69336945
PT = C * (RT - R0) ** 2


def applelog_to_linear(p):
    return np.where(p >= PT, np.power(2.0, (p - BETA) / G) - B, np.where(p >= 0, np.sqrt(np.maximum(p, 0) / C) + R0, R0))


def bake(spec):
    import PyOpenColorIO as ocio

    cfg = ocio.Config.CreateFromFile(CONFIG)
    n = int(spec.get("size", 65))
    axis = np.linspace(0, 1, n, dtype=np.float64)
    b, g, r = np.meshgrid(axis, axis, axis, indexing="ij")  # .cube: red changes fastest
    code = np.stack([r.ravel(), g.ravel(), b.ravel()], axis=-1)
    if spec["input"] == "applelog":
        linear, source = applelog_to_linear(code), "Linear Rec.2020"
    else:
        linear, source = pq_to_linear(code), SPACES[spec["input"]]
    rgb = np.ascontiguousarray((linear * 2.0 ** float(spec.get("stops", 0))).astype(np.float32))

    view = ocio.GroupTransform()
    view.appendTransform(ocio.ColorSpaceTransform(source, "ACES2065-1"))
    view.appendTransform(ocio.BuiltinTransform(OUTPUT_TRANSFORM))
    view.appendTransform(ocio.MatrixTransform(XYZ_TO_REC709))
    cfg.getProcessor(view).getDefaultCPUProcessor().applyRGB(rgb)
    with open(spec["out3d"], "w", newline="\n") as f:
        f.write(f'TITLE "ACES 1.0 SDR-video from {spec["input"]}, linear Rec.709 display light (platepuller)"\n')
        f.write(f"LUT_3D_SIZE {n}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n")
        np.savetxt(f, rgb, fmt="%.7f")

    x = np.linspace(0, 1, 65536)
    y = np.power(x, 1 / 2.4)
    with open(spec["out1d"], "w", newline="\n") as f:
        f.write('TITLE "Rec.1886 display encoding, gamma 2.4 (platepuller)"\n')
        f.write(f"LUT_1D_SIZE {x.size}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n")
        np.savetxt(f, np.stack([y, y, y], axis=-1), fmt="%.7f")


def main(argv):
    if argv[:1] == ["--check"]:
        import PyOpenColorIO as ocio

        ocio.Config.CreateFromFile(CONFIG)
        print("ok")
        return 0
    bake(json.loads(argv[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
