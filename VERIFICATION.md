# 検証ログ

このビューアで確認した内容を記録する共有ベースライン。
（記録先は暫定でこのファイル。将来 Notion / Slack へ移送予定 — TODO）

## 形式比較（同一データ shrine_light, SH無, ~496万splat）

| 形式 | サイズ | 表示までの体感 | LODツリー | Range配信 |
|---|---|---|---|---|
| RAD | 128MB | 速い（チャンク単位） | あり | **対応** |
| SPZ | 108MB | 遅い（全gzip展開後） | あり | 非対応 |
| 生PLY | 278MB | 全DL後 | なし | 非対応 |
| .splat | 159MB | 全DL後 | なし | 非対応 |

- **画質はどの形式もほぼ同一**。build-lod の RAD/SPZ 変換は shrine_light（SH0）では
  見た目の劣化がほぼ無い。
- 差が出るのは配信性能。RAD だけがチャンク独立圧縮＋オフセット表を持ち、
  Range リクエストで見えている部分だけ取得できる（LOD の段階読み込みが成立）。
- SPZ は先頭バイトが gzip（`1f8b`）の単一ストリームで、全体を展開しないと
  ページを切り出せず、`onLoad` 後もしばらくスプラットが増え続ける。

## build-lod の要点

- PLY 等 → LOD ツリー付き RAD/SPZ を生成。既定は bhatt-lod（`--quality`）。
- `--cluster-sh`（SH係数を64Kコードブックに量子化）は **RAD出力専用**。
  shrine_light は SH0 なので効果なし。SH3 データ（shrine_clean 等）でこそ効く。
- `--rad-chunked`（チャンク別ファイル）は npm 版 Spark とチャンクURL命名規則が
  食い違い読めなかった。単一ファイル `--rad` はオフセット表を内包し Range が効くので
  そちらを使用。

## 画質プリセットの効き方

| 項目 | RAD/SPZ | 生PLY/.splat |
|---|---|---|
| lodSplatCount（常駐数上限） | 効く | 効かない |
| lodRenderScale（LOD選択） | 効く | 効かない |
| maxStdDev / blurAmount / pixelRatio | 効く | 効く |

- 生PLY/.splat は LOD ツリーが無いため常に全スプラットが常駐し、スプラット数を
  絞れない。→ 画質ドロップダウンは生形式で自動無効化。
- 過負荷でのクラッシュ注意: レンダーループは `requestAnimationFrame`
  （`renderer.setAnimationLoop`）で回すこと。`setInterval` にすると前フレームの
  非同期GPU処理完了を待たずに発火し続け、GPUキューが溢れて統合メモリMacごと
  落ちる。pixelRatio は Retina で 2.0=フラグメント4倍。

## kiruya 分割パーツ歩行

- 分割パーツ（part_body / legL / legR）は元 `kiruya.ply` の**部分集合**。
  静止状態では元モデルと完全一致する。
- 脚PLYは**股関節ピボット P=(0.0497,0.2502,0) 相対**の座標で保存されている
  （分割時に P を減算）。リグは `hip.position = P`, `leg.position = 0` で配置し、
  hip を回して脚を振る。※ 当初 `leg.position=-P` にして +P 復元が抜け、脚が
  コート内に浮いて足が見えないバグがあった（修正済み）。
- 影スプラットは part_body に同梱。
- 歩行感は「足振り（Z軸・逆位相）＋上下バウンド＋上半身ゆれ＋実際の前進」で表現。
  脚はコートにほぼ隠れるため、全身の揺れで歩いて見せる設計（元 viewer_walk 踏襲）。

## 未検証・TODO

- shrine_clean（SH3, 軽量化前）と原本 shrine.ply の生PLY比較はローカルのみ
  （1.1GB級のため共有セットから除外）。
- ASSET_BASE_URL（共有ストレージ）の確定。
- 検証記録の正式な置き場（Notion/Slack）の決定と移送。
