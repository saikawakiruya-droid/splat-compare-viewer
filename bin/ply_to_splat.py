#!/usr/bin/env python3
"""Convert a 3DGS .ply to the antimatter15 .splat format that Spark decodes.

Spark's decodeAntiSplat expects 32 bytes/splat:
  0..11   position   x,y,z    float32
  12..23  scale      x,y,z    float32 (linear = exp(log_scale))
  24..27  color      r,g,b,a  uint8   (a = opacity, both already 0..255)
  28..31  quaternion w,x,y,z  uint8   (q/|q| * 128 + 128)
"""
import sys
import re
import numpy as np

SH_C0 = 0.28209479177387814


def load_ply(path):
    with open(path, "rb") as f:
        header = b""
        while True:
            line = f.readline()
            header += line
            if line.strip() == b"end_header":
                break
        data = f.read()
    h = header.decode("ascii", "replace")
    n = int(re.search(r"element vertex (\d+)", h).group(1))
    props = re.findall(r"property float (\S+)", h)
    assert len(props) * n * 4 == len(data), (
        f"only float properties supported; {len(props)} props, {n} verts, "
        f"{len(data)} bytes"
    )
    arr = np.frombuffer(data, dtype=np.float32).reshape(n, len(props))
    return {p: arr[:, i] for i, p in enumerate(props)}, n


def to_splat(cols, n):
    out = np.zeros((n, 32), dtype=np.uint8)
    f32 = out.view(np.float32).reshape(n, 8)

    f32[:, 0] = cols["x"]
    f32[:, 1] = cols["y"]
    f32[:, 2] = cols["z"]
    f32[:, 3] = np.exp(cols["scale_0"])
    f32[:, 4] = np.exp(cols["scale_1"])
    f32[:, 5] = np.exp(cols["scale_2"])

    rgb = np.clip(0.5 + SH_C0 * np.stack(
        [cols["f_dc_0"], cols["f_dc_1"], cols["f_dc_2"]], axis=1), 0, 1)
    opacity = 1.0 / (1.0 + np.exp(-cols["opacity"]))
    out[:, 24] = (rgb[:, 0] * 255).round().clip(0, 255)
    out[:, 25] = (rgb[:, 1] * 255).round().clip(0, 255)
    out[:, 26] = (rgb[:, 2] * 255).round().clip(0, 255)
    out[:, 27] = (opacity * 255).round().clip(0, 255)

    q = np.stack([cols["rot_0"], cols["rot_1"], cols["rot_2"], cols["rot_3"]], axis=1)
    q = q / np.linalg.norm(q, axis=1, keepdims=True)
    out[:, 28:32] = (q * 128 + 128).round().clip(0, 255)
    return out


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    cols, n = load_ply(src)
    out = to_splat(cols, n)
    out.tofile(dst)
    print(f"Wrote {dst}: {n} splats, {out.nbytes} bytes")
