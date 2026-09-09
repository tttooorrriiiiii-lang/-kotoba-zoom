# ことばズーム v10

無料運用を前提に、次の3層で抽象化・具体化を支援します。

1. Japanese WordNet 1.1: hypernym / hyponym の本線
2. ConceptNet: WordNetで候補が出ない時だけ IsA を補助表示
3. 自由入力: 辞書にない文章・場面・自分の抽象化もそのまま継続

## Vercel

GitHubリポジトリのルートに、このZIPの中身をそのまま置いてください。
Vercelのビルド時に `npm run build` が走り、日本語WordNet公式SQLite（約60MB gzip）を取得して、ブラウザ用の128個の小さなJSON shardに変換します。

- ビルド成功: WordNet ON
- WordNetの取得・変換に失敗: サイト自体は公開し、ConceptNet + 自由入力へフォールバック

## ファイル

- `index.html`: UI / ConceptNet / 自由入力
- `scripts/build-wordnet.mjs`: Japanese WordNetを静的JSONに変換
- `package.json`: sql.js依存とbuild script
- `vercel.json`: distを公開
- `WORDNET-LICENSE.txt`: Japanese WordNet license

## Attribution

Japanese WordNet 1.1
https://bond-lab.github.io/wnja/index.ja.html

ConceptNet 5
https://conceptnet.io/


## v10.1
GitHub手動アップロード向けに、scriptsフォルダを廃止しました。すべてのファイルをリポジトリ直下へアップロードしてください。
