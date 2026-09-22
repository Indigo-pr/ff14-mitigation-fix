# ff14-mitigation-fix

FF14の軽減表ジェネレーター（[らすと氏](https://note.com/lastagous) 作）で自動生成したタイムラインシートのDamage列を、検算・補正する Google Apps Scriptです。

複数人に当たる技のダメージ値のずれ、ダメージの上振れ下振れを加味した1000単位の切り上げダメージに補正します。（設定変更できます）

- 軽減表ジェネレーターに補正用のタブを追加。
- レイドだけはなく、VD等のコンテンツにも使用可能。
- プレビュー → 選んで適用の2段階で補正を実施。

※ 非公式ツール由来のデータを使用するので、導入は自己責任でお願いします。

---

## 導入

### スクリプトの取り込み

1. 軽減表ジェネレーターのスプレッドシートを開く
2. `拡張機能 → Apps Script`
3. 左の「ファイル」で **＋ → スクリプト** で _新しいファイル_ を作り、
   `apps-script/mitigation_fix.gs` の中身を貼り付けて保存（Ctrl+S）
   > 既存のファイルを上書きしないこと。ジェネレーター本体のコードが消えます。
4. 左の時計アイコン **「トリガー」→「トリガーを追加」**

   | 項目             | 値                   |
   | ---------------- | -------------------- |
   | 実行する関数     | `mfBuildMenu`        |
   | イベントのソース | スプレッドシートから |
   | イベントの種類   | 起動時               |

   保存して権限を承認する。

5. スプレッドシートを再読み込み → メニューに **「軽減表 補正」** が追加される
   ※ 本家の【軽減表拡張機能】が消えている場合は本家スクリプトを上書きしてしまっているので、本家スプレッドシートをコピーしなおしてください。

> **なぜトリガーが必要か**
> Apps Scriptは同じプロジェクト内で関数名が共通になる。`onOpen` を定義するとジェネレーター本体の `onOpen` を上書きし、本家のメニューが消える。
> そのため `mfBuildMenu` という別名にし、起動時トリガーで呼んでいる。
> 同じ理由で、関数名と定数名は全て `mf` / `MF_` を頭に付けて衝突を避けている。

### FFLogs V2 のクライアントを用意する

<https://www.fflogs.com/api/clients/> より作成してください。

---

## 使い方

補正したい軽減表シートを開いた状態で、メニューから順に実行してください。

|     | メニュー             | 内容                                                       |
| --- | -------------------- | ---------------------------------------------------------- |
| ①   | FFLogs認証を設定     | client_id / client_secret を保存（初回だけ）               |
| ②   | 補正プレビューを作成 | `_CORRECTION` シートに差分を出力。**元シートは変更しない** |
| ③   | 選択した補正を適用   | 「適用」にチェックを入れた行だけ反映                       |

②ではFFLogsのレポートURLを入力してください。`#fight=N` が付いていない場合は fight 一覧を出して選ばせる。

```
https://www.fflogs.com/reports/xxxxxxxxxxxx#fight=N
```

### 書き込まれるもの

| 場所           | 内容                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| Damage列       | 採用値（1,000単位で切り上げ済み。切り上げ単位は変更可能）                     |
| Action列       | 技名                                                                          |
| Action列のメモ | 種別 / 発動元 / 実測サンプル数と最大値 / 採用方法 / 回ごとの内訳 / 補正前の値 |

メモの例:

```
種別: 複数対象   発動元: シルキー
実測: 15件 / 最大 94,969 / 発動間隔 約71秒
採用: 対象4人の回の最大値 → 1,000単位で切り上げ
内訳(時刻/対象数/最大): 4:55 4人 52,354 | 6:08 3人 71,749 | 7:17 3人 74,576
                        | 8:47 2人 94,969 | 9:03 3人 72,946
補正前: 43,003
```

---

## 設定

`mitigation_fix.gs` の冒頭で設定変更が可能です。

| 定数             | 既定        | 意味                                                     |
| ---------------- | ----------- | -------------------------------------------------------- |
| `ROUND_UNIT`     | `1000`      | 採用値の切り上げ単位                                     |
| `PICK_MODE`      | `'fullest'` | 複数対象技でどの回を採るか。`'max'` で全回通しての最大値 |
| `TIME_TOLERANCE` | `2.5`       | シート行とログを突き合わせる許容秒数                     |
| `AA_NAMES`       | `攻撃` 等   | この名前の技は通常攻撃(AA)として扱う                     |
| `TANK_JOBS`      | 4タンク     | タンク判定に使うジョブ名（FFLogsの `subType`）           |

---

## 同梱物

```
apps-script/mitigation_fix.gs   本体
apps-script/appsscript.json     clasp 用のマニフェスト
tools/fflogs_unmitigated.py     FFLogsから素ダメージ付きCSVを吐く単体スクリプト（検証・調査用）
tools/load-env.ps1              .env を環境変数に読み込む（Windows / PowerShell 用）
.env.example                    調査用スクリプトが使う環境変数の雛形
docs/findings.md                ログ解析で判明した事実（検証データ付き）
docs/decisions.md               設計判断とその理由
investigations/                 調査・検算の作業場（運用ルールは investigations/README.md）
```

---

### 調査用スクリプトを動かす(開発用)

毎回キーを打ち直さなくて済むよう、`.env` に置いて読み込めます。

```powershell
Copy-Item .env.example .env    # 初回だけ。client_id / client_secret を書き込む
. .\tools\load-env.ps1         # 先頭の "." が必須。無いと効かない
```

レポートは**第1引数で渡す**。本体ツールと同じURLをそのまま貼りつけて分析が可能です。

```powershell
# 戦闘一覧を見る
python tools/fflogs_unmitigated.py "https://www.fflogs.com/reports/xxxx"

# URL に #fight=N があればその戦闘を CSV 出力
python tools/fflogs_unmitigated.py "https://www.fflogs.com/reports/xxxx#fight=N"

# コード直指定。fight は複数可、all で全戦闘
python tools/fflogs_unmitigated.py xxxx 12 13 14
python tools/fflogs_unmitigated.py xxxx all
```

> **URL は必ずクォートで囲むこと。** シェルは `#` 以降をコメントとみなすため、
> 囲まないと `#fight=N` が消えて戦闘一覧が出るだけになる。

`FFLOGS_REPORT` を `.env` に入れておけば第1引数は省略できる。

`.env` は `.gitignore` 済み。**Apps Script 本体はこれを使わない**（あちらはスクリプトプロパティ）。

### Apps Script をGitで管理する

Apps Scriptはスプレッドシート側が正本になるため、手でコピペしていると必ずズレる。
[clasp](https://github.com/google/clasp) を使うと双方向に同期できる。

```bash
npm install -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json   # scriptId を埋める
clasp push     # ローカル → スプレッドシート
clasp pull     # スプレッドシート → ローカル
```

`scriptId` は Apps Script エディタの `プロジェクトの設定` にある。

開発中の経緯は [docs/findings.md](docs/findings.md)、設計判断の理由は [docs/decisions.md](docs/decisions.md)にまとめています。

---

## ライセンス

個人利用。ジェネレーター本体はらすと氏の著作物であり、このリポジトリには含まない。
