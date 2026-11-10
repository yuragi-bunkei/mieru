# showreel — コードだけで作った60秒の映像

[`showreel.mp4`](showreel.mp4)（1920×1080 / 30fps / 60秒 / 音声つき）と、それを生成するプログラム一式です。
mieru 本体（STLビューア）の機能とは無関係な、独立したデモ映像です。

- 画像・動画・3Dモデル・録音済み音源などの**素材ファイルは使っていません**
- 映像は WebGL2 のシェーダ（画素ごとに実行される小さなプログラム）で1フレームずつ描画
- 音楽は発振器（のこぎり波・正弦波）と乱数ノイズから合成
- 例外は文字で、実行環境に入っているフォント（Inter / JetBrains Mono / IPA Pゴシック）を使います

## 構成

| 時間 | 場面 | 何をしているか |
|---|---|---|
| 0–4秒 | 起動画面 | コマンドを打つ演出。打鍵音は文字が出る時刻に合わせて合成 |
| 4–12秒 | PARTICLES | 40万個の粒子。位置は「粒子番号と時刻」から毎フレーム直接計算（状態を持たない） |
| 12–20秒 | LORENZ ATTRACTOR | ローレンツ方程式を4次ルンゲ＝クッタ法で数値積分。初期値が各座標0.01以内でずれた150本の軌道が分かれていく様子 |
| 20–28秒 | JULIA SET | z → z² + c を画素あたり4点、各最大300回反復 |
| 28–36秒 | MANDELBULB | 距離関数に沿って光線を進めるレイマーチングで描く3Dフラクタル |
| 36–44秒 | PROCEDURAL LANDSCAPE | ノイズ関数を重ねた地形・水面の反射・雲。この場面だけ内部解像度 1440×810 で描いて拡大 |
| 44–52秒 | INFINITE CITY | 1棟ぶんの距離関数を空間のくり返しで並べた都市。路面と壁に反射あり |
| 52–60秒 | 結び | 粒子の銀河とテキスト |

音楽は 120 BPM（1小節＝2秒）で、場面の切り替わりが小節の頭に一致します。
キックが鳴る区間（12–28秒・36–52秒）は、映像側も同じ拍で明るさや画角が動きます。

## ファイル

| ファイル | 役割 |
|---|---|
| `film.html` / `film.js` | 映像本体。`window.renderFrame(n)` で n 番目のフレームを描く。全場面が時刻の純関数なので、任意のフレームを単独で再現できる |
| `render.js` | ヘッドレスChromiumで `film.html` を1フレームずつ描き、PNG連番で保存 |
| `audio.js` | 音楽を合成して WAV に書き出す（依存ライブラリなし） |
| `showreel.mp4` | 完成品 |

## 作り直す手順

必要なもの: Node.js、[Playwright](https://playwright.dev/)（Chromium同梱）、ffmpeg。
Playwright は mieru 本体の依存には含めていないので、別途インストールしてください。

```bash
cd docs/showreel
node render.js --out /tmp/frames --workers 4      # 1,800フレームを描画
node audio.js /tmp/showreel.wav                   # 音楽を合成
ffmpeg -framerate 30 -i /tmp/frames/f%05d.png -i /tmp/showreel.wav \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  -c:a aac -b:a 192k -movflags +faststart showreel.mp4
```

- 描画は途中で止めても、同じコマンドで続きから再開します（既にあるフレームは飛ばす）
- 一部だけ確認するとき: `node render.js --out /tmp/still --times 5,14.5,30 --fast`
  （`--times` は秒指定、`--fast` は低解像度・ブラーなしの確認用）

## 注意

- GPUのない環境でも動きます（Chromium のソフトウェア描画）。同梱の mp4 は CPU 4コアの環境で描画しました
- GPUやドライバが違うと、浮動小数点の丸めの差で画素単位では一致しないことがあります
- 上記のフォントが入っていない環境では代替フォントになり、文字の見た目が変わります
- 音楽は音量（約 −14 LUFS）と帯域バランスを数値で確認していますが、人の耳での試聴確認は経ていません
