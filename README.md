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

スプラットの実データは容量が大きいため Git には含めない。`assets-manifest.json` に
一覧があり、`scripts/fetch-assets.sh` が `ASSET_BASE_URL` から `public/` に取得する。
`jq` が必要（`brew install jq`）。手動で `public/` に置いてもよい。

共有セット（約 700MB、100MB 超のファイルを含む）:

| シーン | 形式 |
|---|---|
| shrine_light (SH無) | RAD 128MB / SPZ 108MB / 生PLY 278MB / .splat 159MB |
| kiruya | RAD 7.4MB / SPZ 5.5MB / 生PLY 17MB / .splat 8MB |
| kiruya — 歩行 | part_body / part_legL / part_legR (計 ~17MB) |

**除外:** `shrine.ply`・`shrine_clean.ply`（各 1.1GB）と `shrine_clean-lod.rad`（307MB）。
ローカルに実データがあれば `main.js` の `SCENES` に追記すれば復活できる。

**ASSET_BASE_URL の置き場所:** ＜チームで決めて追記＞

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
