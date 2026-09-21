# ff14-mitigation-fix

FF14の軽減表ジェネレーター（[@lastagous](https://note.com/lastagous) 作）が FFLogs から自動生成した
タイムラインシートの **Damage列を、FFLogs V2 API の素ダメージで検算・補正する** Google Apps Script。

ジェネレーターの自動生成は時刻・技名・属性まで正確だが、
**複数人に当たる技のダメージ値がずれる**（過小2〜3割／タンク強攻撃は過大）ため、そこだけ直す。

- 軽減表そのものは作らない。既存のジェネレーターに乗る
- ボス固有の値は一切ハードコードしていない。どの戦闘でも使える
- 必ず「プレビュー → 選んで適用」の2段階。いきなり書き換えない

詳しい経緯は [docs/findings.md](docs/findings.md)、設計判断の理由は [docs/decisions.md](docs/decisions.md)。

---

## 導入

1. 軽減表ジェネレーターのスプレッドシートを開く
2. `拡張機能 → Apps Script`
3. `apps-script/mitigation_fix.gs` の中身を貼り付けて保存
4. スプレッドシートを再読み込み → メニューに **「軽減表 補正」** が出る

### FFLogs V2 のクライアントを用意する

<https://www.fflogs.com/api/clients/> で作成する。

| 項目 | 値 |
|---|---|
| Application name | 用途がわかる英語名 |
| Redirect URLs | `https://localhost:4433`（この用途では使わないが必須項目） |
| Public Client | **チェックしない**（チェックすると client_secret が発行されない） |

> ジェネレーター本体のタイムライン自動生成が使うのは **V1 Client Key**。別物なので両方必要。
> V1側は `V1 Client Name` が未設定だと 403 で弾かれる。

---

## 使い方

補正したい軽減表シートを開いた状態で、メニューから順に実行する。

| | メニュー | 内容 |
|---|---|---|
| ① | FFLogs認証を設定 | client_id / client_secret を保存（初回だけ） |
| ② | 補正プレビューを作成 | `_CORRECTION` シートに差分を出力。**元シートは変更しない** |
| ③ | 選択した補正を適用 | 「適用」にチェックを入れた行だけ反映 |

②ではFFLogsのURLを聞かれる。`#fight=N` が付いていない場合は fight 一覧を出して選ばせる。

```
https://www.fflogs.com/reports/xxxxxxxxxxxx#fight=9
```

### 書き込まれるもの

| 場所 | 内容 |
|---|---|
| Damage列 | 採用値（1,000単位で切り上げ済み） |
| Action列 | 技名のみ（過去に付けた `【…】` タグがあれば除去） |
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

人数が減るほど値が上がる＝頭割り、と **人間が判断できる情報を出す**。ツールは断定しない。

---

## 設定

`mitigation_fix.gs` の冒頭。

| 定数 | 既定 | 意味 |
|---|---|---|
| `ROUND_UNIT` | `1000` | 採用値の切り上げ単位 |
| `PICK_MODE` | `'fullest'` | 複数対象技でどの回を採るか。`'max'` で全回通しての最大値 |
| `TIME_TOLERANCE` | `2.5` | シート行とログを突き合わせる許容秒数 |
| `AA_NAMES` | `攻撃` 等 | この名前の技は通常攻撃(AA)として扱う |
| `TANK_JOBS` | 4タンク | タンク判定に使うジョブ名（FFLogsの `subType`） |

---

## 同梱物

```
apps-script/mitigation_fix.gs   本体
apps-script/appsscript.json     clasp 用のマニフェスト
tools/fflogs_unmitigated.py     FFLogsから素ダメージ付きCSVを吐く単体スクリプト（検証・調査用）
docs/findings.md                ログ解析で判明した事実（検証データ付き）
docs/decisions.md               設計判断とその理由
```

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

---

## やっていないこと / 既知の限界

- **DoT列は補正しない**。Hit列のみ。水洗いのような継続ダメージを持つ技はジェネレーターの値のまま
- **フェーズ制ボス**で同名・別威力の技があると混ざる。安全側（過大）に倒れる
- **被ダメージ上昇デバフ**が乗った状態の値が混ざると過大評価になる。未対応
- 1トライぶんのログしか見ない。**複数ログのマージは未実装**（次の優先課題）

## ライセンス

個人利用。ジェネレーター本体は @lastagous 氏の著作物であり、このリポジトリには含まない。
