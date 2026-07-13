# Splat 比較ビューア

3D Gaussian Splatting を **形式 × シーン × 画質** で見比べ、kiruya アバターの **分割パーツ歩行** を確認するための検証用ビューア（Spark + three.js + Vite）。

チームで共有し、各自ローカルで起動して同じ検証を行う。

## セットアップ

```bash
npm install
# アセットを取得（下記「アセット」参照）
ASSET_BASE_URL="https://<共有ストレージのベースURL>" ./scripts/fetch-assets.sh
npx vite
```

ブラウザで **http://localhost:5173/** を開く。

> **注意:** タブを前面（フォアグラウンド）にして見ること。バックグラウンドタブでは
> ブラウザが `requestAnimationFrame` を間引くため、スプラットのソートが進まず
> 描画が止まって見える。

## アセット

スプラットの実データは容量が大きいため Git には含めない。共有セットを取得して
`viewer/public/` に置く。`assets-manifest.json` が必要ファイルの一覧。

共有セット（約 1.0GB、100MB 超のファイルを含む）:

| シーン | 形式 |
|---|---|
| shrine_light (SH無) | RAD 128MB / SPZ 108MB / 生PLY 278MB / .splat 159MB |
| shrine_clean (SH3) | RAD 307MB |
| kiruya | RAD 7.4MB / SPZ 5.5MB / 生PLY 17MB / .splat 8MB |
| kiruya — 歩行 | part_body / part_legL / part_legR (計 ~17MB) |

**除外は生の巨大PLYのみ:** `shrine.ply`・`shrine_clean.ply`（各 1.1GB）。
ローカルに実データがあれば `main.js` の `SCENES` に追記すれば復活できる。

### 入手方法A: Google Drive（現行）

共有 Drive フォルダ: **＜共有フォルダのリンクをここに記入＞**

1. フォルダ内の全ファイルをダウンロード。
2. `viewer/public/` に置く（`assets-manifest.json` の名前どおり）。

> Drive は大きいファイルの Range/CORS に対応しないため、ブラウザから直接読むのではなく
> 一度 `public/` に落とす。ローカルの Vite が配信するので RAD の Range 読みもローカルで効く。

### 入手方法B: 静的ホスト（S3 / R2 等がある場合）

`ASSET_BASE_URL` にベース URL を設定して取得（`jq` が必要）:

```bash
ASSET_BASE_URL="https://<host>/<path>" ./scripts/fetch-assets.sh
```

## 操作

- **Scene / Format / Quality** ドロップダウンで切り替え。
- 歩行シーン（`kiruya — 歩行`）:
  - **W/S** 前後・**A/D** 旋回・**Q/E** 横歩
  - **マウスドラッグ** カメラ周回・**ホイール** ズーム
  - スライダーで足振り・上下バウンド・上半身ゆれ・速度を調整

## 形式と画質の要点

- **RAD** … Spark 独自の LOD 形式。チャンクごとに独立圧縮され、HTTP Range で
  必要部分だけ取得できる（Web 配信で段階表示が効く唯一の形式）。
- **SPZ** … LOD 付きだが単一 gzip ストリーム。全展開まで表示が遅れる。
- **生PLY / .splat** … LOD 無し。全スプラットが常駐。`.splat` は SH 無し・8bit 量子化の簡易形式。
- **画質プリセット**（`lodSplatCount` / `lodRenderScale` / `maxStdDev` / `blurAmount` / `pixelRatio`）は
  LOD 形式（RAD/SPZ）でのみ全項目が効く。生PLY/.splat は LOD が無いため
  スプラット数を絞れず、画質ドロップダウンは自動で無効化される。

検証で分かった具体的な比較結果は [VERIFICATION.md](./VERIFICATION.md) を参照。
