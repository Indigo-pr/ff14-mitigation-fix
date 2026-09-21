# investigations/

調査・検算の作業場。**ここは読み返さなくていい状態**にしておく。

確定した結論は `docs/findings.md` に、設計判断は `docs/decisions.md` に昇格させる。
そちらだけが常に最新の正解を持つ。

## 置き方

```
investigations/YYYY-MM-DD-<短いテーマ名>/
├─ NOTES.md      何を調べて、何が分かったか
├─ data/         FFLogsから取ったCSVなど（小さいもの）
└─ scripts/      その時使った解析スクリプト
```

## 入れるもの / 入れないもの

| | 判断 | 理由 |
|---|---|---|
| ACTの生ログ | ❌ | 20MB級。再取得できる |
| FFLogsから取ったCSV | ✅ | findings.md の主張の裏付けになる |
| 使い捨ての解析スクリプト | ✅ | 再現手段が残る。汚くてよい |
| 認証情報・レポートコード | ❌ | 限定公開ログのコードも書かない |

`.gitignore` は `*.csv` を弾くが `investigations/**/data/*.csv` だけ通すようにしてある。

## NOTES.md の型

```markdown
# <テーマ>  YYYY-MM-DD

## 調べたかったこと

## 使ったデータ
レポート: （コードは書かない。日付とボス名だけ）
fight: N / 継続 N秒 / PT構成

## わかったこと
- 事実と数字。推測は「推測」と明記する

## docs/ に昇格させたもの
- findings.md の「◯◯」に追記
- decisions.md の「◯◯」を変更

## 未解決・積み残し
```

## 次のセッションで再開する時

`docs/findings.md` と `docs/decisions.md` を読めば文脈が戻る。
この2つは **後から読む人（未来の自分やAI）に渡す前提**で書き続けること。
`investigations/` を全部読ませる必要はない。
