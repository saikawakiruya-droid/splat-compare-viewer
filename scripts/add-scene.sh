#!/usr/bin/env bash
# Register a .ply as a comparison scene.
#
# Generates the four comparison formats from one .ply and adds the scene to
# public/scenes.json, so it shows up in the viewer's Scene dropdown with all
# formats selectable for side-by-side comparison:
#   <name>-lod.rad   RAD (LOD, Range 配信可)      ← build-lod
#   <name>-lod.spz   SPZ (LOD)                    ← build-lod
#   <name>.splat     .splat (LOD無, SH無/8bit)    ← ply_to_splat.py
#   <name>.ply       生PLY (LOD無)                ← コピー
#
# Usage:
#   ./scripts/add-scene.sh <file.ply> [name] [label]
#     file.ply : 入力 3DGS PLY（float プロパティのみ対応）
#     name     : 内部キー/ファイル名（省略時 = 入力ファイル名。英数_- に正規化）
#     label    : ドロップダウン表示名（省略時 = name）
#
# チーム共有: viewer/ を受け取ったメンバーは `npm install` 後、このスクリプトを
# viewer/ から実行するだけ。変換ツールは bin/ に同梱済み（build-lod, ply_to_splat.py）。
# 必要環境: python3 + numpy、Apple Silicon Mac（build-lod は arm64 ネイティブ）。
set -euo pipefail
cd "$(dirname "$0")/.."   # -> viewer/

BUILD_LOD="$PWD/bin/build-lod"
PLY2SPLAT="$PWD/bin/ply_to_splat.py"

SRC="${1:-}"
if [ -z "$SRC" ]; then
  echo "usage: ./scripts/add-scene.sh <file.ply> [name] [label]" >&2
  exit 1
fi
[ -f "$SRC" ] || { echo "入力が見つかりません: $SRC" >&2; exit 1; }

base="$(basename "$SRC")"; base="${base%.*}"
RAW_NAME="${2:-$base}"
NAME="$(printf '%s' "$RAW_NAME" | tr ' ' '_' | tr -cd 'A-Za-z0-9_-')"
[ -n "$NAME" ] || { echo "name が空です（英数_- のみ有効）: '$RAW_NAME'" >&2; exit 1; }
LABEL="${3:-$RAW_NAME}"

command -v python3 >/dev/null 2>&1 || { echo "python3 が必要です" >&2; exit 1; }
python3 -c "import numpy" 2>/dev/null || { echo "numpy が必要です (pip install numpy)" >&2; exit 1; }
[ -x "$BUILD_LOD" ] || { echo "build-lod が無い/実行不可: $BUILD_LOD" >&2; exit 1; }
[ -f "$PLY2SPLAT" ] || { echo "ply_to_splat.py が無い: $PLY2SPLAT" >&2; exit 1; }

mkdir -p public

echo "[1/5] 生PLYをコピー -> public/$NAME.ply"
cp "$SRC" "public/$NAME.ply"

echo "[2/5] RAD(LOD) を生成 ..."
"$BUILD_LOD" --rad --quality "public/$NAME.ply" >/dev/null   # -> public/$NAME-lod.rad

echo "[3/5] SPZ(LOD) を生成 ..."
"$BUILD_LOD" --spz --quality "public/$NAME.ply" >/dev/null   # -> public/$NAME-lod.spz

echo "[4/5] .splat を生成 ..."
python3 "$PLY2SPLAT" "public/$NAME.ply" "public/$NAME.splat" >/dev/null

echo "[5/5] public/scenes.json に登録 ..."
NAME="$NAME" LABEL="$LABEL" python3 - <<'PY'
import json, os, re, math
import numpy as np
name  = os.environ["NAME"]
label = os.environ["LABEL"]
path  = "public/scenes.json"

# --- カメラを PLY バウンズから算出 -------------------------------------------
# メッシュは quaternion(1,0,0,0) で y,z を反転して表示するので world=(x,-y,-z)。
# 生バウンズは空/浮遊物の外れ値に支配される（SCENES のコメント参照）ため、
# 各軸 1-99 パーセンタイルで芯を取り、その正面から収まる距離にカメラを置く。
def ply_camera(ply_path, fov_deg=75):
    with open(ply_path, "rb") as f:
        header = b""
        while True:
            line = f.readline(); header += line
            if line.strip() == b"end_header":
                break
        data = f.read()
    h = header.decode("ascii", "replace")
    n = int(re.search(r"element vertex (\d+)", h).group(1))
    props = re.findall(r"property float (\S+)", h)
    arr = np.frombuffer(data, dtype=np.float32).reshape(n, len(props))
    idx = {p: i for i, p in enumerate(props)}
    x, y, z = arr[:, idx["x"]], arr[:, idx["y"]], arr[:, idx["z"]]
    wx, wy, wz = x, -y, -z          # 表示時の反転を反映
    ax = []
    for a in (wx, wy, wz):
        lo, hi = np.percentile(a, [1, 99]); ax.append((float(lo), float(hi)))
    c = [(lo + hi) / 2 for lo, hi in ax]
    size = [hi - lo for lo, hi in ax]
    maxDim = max(size) or 1.0
    dist = (maxDim * 0.6) / math.tan(fov_deg * math.pi / 360) + maxDim * 0.5
    return {"pos": [c[0], c[1], c[2] + dist], "look": c}

try:
    camera = ply_camera(f"public/{name}.ply")
except Exception as e:
    print("  カメラ算出をスキップ（自動フレーミングにフォールバック）:", e)
    camera = None

# --- 形式一覧 ---------------------------------------------------------------
formats = {}
def add(key, fname, base_label):
    p = os.path.join("public", fname)
    if not os.path.exists(p):
        return
    sz = os.path.getsize(p)
    human = f"{sz/1024/1024:.1f}MB" if sz >= 1024*1024 else f"{max(1, sz//1024)}KB"
    formats[key] = {"file": "/" + fname, "label": f"{base_label} ({human})"}
add("rad",   f"{name}-lod.rad", "RAD — LOD")
add("spz",   f"{name}-lod.spz", "SPZ — LOD")
add("ply",   f"{name}.ply",     "生PLY — LOD無")
add("splat", f"{name}.splat",   ".splat — LOD無")

data = {"scenes": []}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
scenes = [s for s in data.get("scenes", []) if s.get("key") != name]  # 再登録は置換
entry = {"key": name, "label": label, "formats": formats}
if camera:
    entry["camera"] = camera
scenes.append(entry)
data["scenes"] = scenes
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print("  登録形式:", ", ".join(formats) or "(なし)")
PY

echo
echo "完了: シーン '$LABEL' を登録しました。"
echo "  → ビューアを開き（起動中なら再読込）Scene で '$LABEL' を選択して比較できます。"
echo "  → 未起動なら: npx vite"
