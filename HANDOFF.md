# 引き継ぎ書: ヒートインサート圧入治具（heat-insert-press）

> リモートセッション（Claude Code on the web）からデスクトップのClaude Codeへの引き継ぎ。
> **このファイルは引き継ぎ用の一時ファイル。PRマージ前に削除すること。**

作成日: 2026-09-02 / 引き継ぎ元セッション: session_01PbJD96iWVWxterKLAnKgvH

## 1. 現在の状態（3行要約）

- `examples/heat-insert-press/` に、はんだごてを垂直保持してインサートナット（M3想定）を圧入する治具のJSCADパラメトリックモデルを実装済み
- PR #2（ドラフト）としてプッシュ済み。マージ可能・レビューなし・CIなし
- 残タスクは「ユーザーのはんだごて実寸の反映」と「実印刷での嵌合検証」

## 2. リポジトリ状態

| 項目 | 値 |
| --- | --- |
| ブランチ | `claude/diy-heat-insert-tool-z7vjkg`（origin にプッシュ済み） |
| PR | https://github.com/yuragi-bunkei/mieru/pull/2 （draft, base: main） |
| 最新コミット | `82a65c6` feat(examples): 案内を608ベアリングの転がり式に再設計 |
| 未コミット | なし（このHANDOFF.mdを除く） |

## 3. 設計の要点と経緯

1. **v1: アリ溝スライド式** → ユーザー指摘「樹脂同士の摺動はスティックスリップ（カクつき）が危ない」で廃止
2. **v2（現行）: 608ZZベアリング6個の転がり式**（ユーザーが選択肢から選択）
   - 前面4個・背面2個で角柱レール（40×30mm、高さ220mm）を挟む
   - 戻り抵抗は摩擦ではなく**輪ゴムの弾性**（柱上部の周回溝＋キャリッジ右側面ペグ）
   - 印刷公差のガタは**背面軸の偏心ブッシュ**（±0.75mm）で組立後調整
   - こては割りリング＋M4ボルト2本でクランプ
3. 設計中に修正した干渉: フレーム側ペグはキャリッジ（柱を囲むスリーブ）が通過できないため、凹みの周回溝に変更した。**柱側面への突起追加は禁物**（同じ干渉が再発する）

詳細は `examples/heat-insert-press/README.md` と `model.js` 冒頭コメントを参照。

## 4. 作業の再開方法

```bash
git fetch origin claude/diy-heat-insert-tool-z7vjkg
git checkout claude/diy-heat-insert-tool-z7vjkg
npm install                          # mieru本体の依存
cd examples/heat-insert-press && npm install
npm run build      # 印刷用STL → stl/
npm run assembly   # 組立プレビュー → stl/assembly.stl
cd ../.. && node server.js examples/heat-insert-press/stl   # mieruで表示
```

デスクトップならBrowserペインに http://localhost:5301 を並べて、モデル修正→自動リロードで確認できる（このリポジトリ本来の使い方）。

## 5. 残タスク（優先順）※2026-09-02 デスクトップ側で更新

1. ~~こて外径の反映~~ **完了**: こてはYIHUA 928D-IIIで確定・実測済み（最太部⌀22.0、直胴47.5mm、ボタンまで5mm）。
   リング高さ40mm化・ボア⌀22.6・M3インサート締結（下穴⌀4.6×6.0/バカ穴⌀3.4/座繰り⌀6.5×4）に再設計済み
2. **実印刷での嵌合検証**: 軸穴⌀8.3・ブッシュ穴⌀12.2・ベアリング転がり面・クランプボア⌀22.6は未印刷・未検証。
   きつい場合は `P.axleHole` / `P.bushHole` / `P.padGap` / `P.clampClear` を調整
3. **M3インサート用チップ**: こて先は市販品（例: ShineNow M2〜M8セット）を使う想定。治具側の対応は不要
4. マージ時: PRをdraft解除し、**このHANDOFF.mdを削除**する

## 6. 検証済み事項

- `npm run build` / `npm run assembly` でSTL生成成功
- mieru上で目視確認済み: ベアリング配置、ボア、スリット、軸穴、周回溝、パーツ間干渉なし（スクリーンショット: `examples/heat-insert-press/docs/preview-*.png`）
- ルート `npm test` 全12件パス（サーバー側コード変更なし）

## 7. 運用メモ

- コミットは日本語のconventional commit風（既存ログ参照）。プッシュ先は同ブランチのみ
- リモートセッション側でPR #2の監視（約3時間間隔のチェックイン）が動いている。
  デスクトップ側で作業を引き継いだら、リモートセッションに「PR監視を止めて」と伝えれば停止する
- 単位はすべてmm。座標系はZ上向き、柱前面が y=30
