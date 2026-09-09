# ことばズーム v10.4

無料運用のまま、日本語WordNetを「そのまま見せる」のではなく、思考トレーニング向けに整える版です。

## v10.4 の修正

- 名詞: hypernym / hyponym を本線にする
- 動詞: hypernym を「より広い動作」、逆方向を「より具体的な動作」として扱う
- 形容詞: Attr（属性）から名詞概念へ橋渡しする
- Similar / Entailment / Cause は上下階層には混ぜず、思考ヒントとして表示
- synset IDを直接たどる `sense shard` を追加し、表示語を言い換えても意味固定が切れない
- WordNet → 内蔵辞書 → WordNet の意味リセットを避け、WordNet候補を最優先
- 「指→一指→指」のような近い言い換えは最大2段先まで飛ばして、実際に広くなる候補を出す
- 「付属肢」など一部の難しい辞書語を、表示上はやさしい日本語にする
- 「実体 / 抽象的実体 / 属性」など、思考練習では遠すぎる辞書最上層を非表示
- 「物 / 物質 / 性質 / 状態 / 感情 / 行為 / 活動 / 出来事 / 現象 / 概念 / 生物 / 生命体」は上方向の自然な停止点として扱う
- 自由入力、ConceptNet補助、5回ズーム、思考の足あとはそのまま維持

## GitHub / Vercel

ZIP内の6ファイルをすべてリポジトリ直下へ上書きしてください。Vercelが自動ビルドします。

- `index.html`
- `build-wordnet.mjs`
- `package.json`
- `vercel.json`
- `WORDNET-LICENSE.txt`
- `README.md`

ビルド時に Japanese WordNet 1.1 のSQLiteを取得し、ブラウザ用に lemma shard 128個 + synset shard 128個へ変換します。

Japanese WordNetの日本語同義語・定義には未修正の誤りが含まれる可能性があるため、このサイトでは自由入力を常に残します。
