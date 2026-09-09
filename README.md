# ことばズーム v10.6

WordNetの意味固定＋観点分岐＋Wikidata固有名詞対応版。

## v10.6 の主な変更
- 「尊い」を 価値 / 品格 / 神聖さ / 感情 の観点に分岐
- 人名・作品名・地名・会社名などを Wikidata で補助
  - 人物 → 人間 / 職業
  - 作品 → 種類 / ジャンル
  - 企業・組織 → 種類 / 分野
- ↓具体化では、実際に通った言葉を候補一覧の一番上に表示
- 思考の足あとから過去地点へ戻っても、以前の意味IDを維持
- WordNetの名詞・動詞・形容詞、ConceptNet補助、自由入力は継続

## 公開
この6ファイルを GitHub リポジトリ直下へ上書きしてください。
Vercel は `npm run build` → `dist` を公開します。

## 無料データ
- Japanese WordNet 1.1
- Wikidata (CC0)
- ConceptNet 5 (CC BY-SA 4.0)
