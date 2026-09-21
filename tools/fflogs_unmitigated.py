#!/usr/bin/env python3
# docstring 内に Windows のパス（.\tools\... など）を書くため raw 文字列にしている。
# 通常の文字列だと \t がタブに化け、\l は不正なエスケープ警告になる。
r"""
FFLogs v2 API から「軽減前ダメージ(unmitigatedAmount)」付きの被弾タイムラインを取得する。

使い方:
    pip install requests

    # Windows (PowerShell) — 雛形をコピーして値を書き、読み込ませるのが楽
    Copy-Item .env.example .env
    . .\tools\load-env.ps1
    python fflogs_unmitigated.py

    # 直接指定する場合 (PowerShell)
    $env:FFLOGS_CLIENT_ID="＜発行されたclient_id＞"
    $env:FFLOGS_CLIENT_SECRET="＜発行されたsecret＞"
    python fflogs_unmitigated.py

    # macOS / Linux
    export FFLOGS_CLIENT_ID=＜発行されたclient_id＞
    export FFLOGS_CLIENT_SECRET=＜発行されたsecret＞
    python3 fflogs_unmitigated.py

引数:
    第1引数にレポートの URL かコードを渡す。以降が fight の指定。

    python fflogs_unmitigated.py "https://www.fflogs.com/reports/xxxx"
        → その戦闘一覧を表示するだけ

    python fflogs_unmitigated.py "https://www.fflogs.com/reports/xxxx#fight=9"
        → URL に #fight=N があればその戦闘を CSV 出力

    python fflogs_unmitigated.py xxxx 12 13 14   # fight を複数指定
    python fflogs_unmitigated.py xxxx all        # 全戦闘

    ※ URL は必ずクォートで囲むこと。
      シェルは # 以降をコメントとみなすため、囲まないと #fight=N が消える。

    環境変数 FFLOGS_REPORT にレポートを入れておけば第1引数は省略できる。
    その場合は従来どおり `python fflogs_unmitigated.py 12` で動く。
"""

import csv
import os
import re
import sys
import collections

import requests

TOKEN_URL = "https://www.fflogs.com/oauth/token"
API_URL = "https://www.fflogs.com/api/v2/client"

CLIENT_ID = os.environ.get("FFLOGS_CLIENT_ID")
CLIENT_SECRET = os.environ.get("FFLOGS_CLIENT_SECRET")

# FFLogs ではステータス(バフ/デバフ)の ID が 1,000,000 + ステータスID で表現される
STATUS_OFFSET = 1_000_000

# レポートコードは 16 文字が標準だが、念のため下限だけ見る
_REPORT_IN_URL = re.compile(r"reports/([A-Za-z0-9]{10,})")
_BARE_CODE = re.compile(r"^[A-Za-z0-9]{10,}$")
_FIGHT_IN_URL = re.compile(r"fight=(\d+)")

USAGE = """レポートを指定してください。

  python tools/fflogs_unmitigated.py "https://www.fflogs.com/reports/xxxx#fight=9"
  python tools/fflogs_unmitigated.py xxxx 12 13 14
  python tools/fflogs_unmitigated.py xxxx all

  ※ URL は必ずクォートで囲むこと。囲まないとシェルが # 以降を捨てます。

  環境変数 FFLOGS_REPORT に入れておけば第1引数は省略できます。"""


def parse_report_input(s):
    """URL またはレポートコードから (code, fight) を取り出す。

    Apps Script 側の mfParseReportInput と同じ挙動にしてある。
    同じ URL を両方のツールにそのまま貼れるようにするため。
    読み取れなければ code は None を返す。
    """
    s = (s or "").strip()

    code = None
    m = _REPORT_IN_URL.search(s)
    if m:
        code = m.group(1)
    elif _BARE_CODE.match(s):
        code = s

    f = _FIGHT_IN_URL.search(s)
    fight = int(f.group(1)) if f else None

    return code, fight


def get_token():
    if not CLIENT_ID or not CLIENT_SECRET:
        sys.exit("環境変数 FFLOGS_CLIENT_ID と FFLOGS_CLIENT_SECRET を設定してください。")
    r = requests.post(
        TOKEN_URL,
        data={"grant_type": "client_credentials"},
        auth=(CLIENT_ID, CLIENT_SECRET),
        timeout=30,
    )
    if r.status_code != 200:
        sys.exit(f"トークン取得に失敗: {r.status_code} {r.text[:300]}")
    return r.json()["access_token"]


def gql(token, query, variables):
    r = requests.post(
        API_URL,
        json={"query": query, "variables": variables},
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    if r.status_code != 200:
        sys.exit(f"APIエラー: {r.status_code} {r.text[:500]}")
    body = r.json()
    if "errors" in body:
        sys.exit("GraphQLエラー: " + str(body["errors"])[:500])
    return body["data"]


REPORT_QUERY = """
query($code: String!) {
  reportData {
    report(code: $code) {
      title
      startTime
      fights {
        id
        name
        startTime
        endTime
        kill
        difficulty
        encounterID
        fightPercentage
      }
      masterData(translate: true) {
        actors { id name type subType }
        abilities { gameID name type }
      }
    }
  }
}
"""

EVENTS_QUERY = """
query($code: String!, $fight: Int!, $start: Float!, $end: Float!) {
  reportData {
    report(code: $code) {
      events(
        fightIDs: [$fight]
        dataType: DamageTaken
        hostilityType: Friendlies
        startTime: $start
        endTime: $end
        limit: 10000
      ) {
        data
        nextPageTimestamp
      }
    }
  }
}
"""


def fetch_events(token, report_code, fight):
    """1戦闘ぶんの被弾イベントをページングしながら全部取る。"""
    out = []
    cursor = float(fight["startTime"])
    end = float(fight["endTime"])
    while cursor is not None and cursor < end:
        data = gql(token, EVENTS_QUERY, {
            "code": report_code, "fight": fight["id"],
            "start": cursor, "end": end,
        })
        page = data["reportData"]["report"]["events"]
        out.extend(page["data"] or [])
        nxt = page.get("nextPageTimestamp")
        if nxt is None or (cursor is not None and nxt <= cursor):
            break
        cursor = float(nxt)
    return out


def resolve_report(argv):
    """引数と環境変数からレポートコードと fight 指定を決める。

    返り値は (report_code, rest, fight_from_url)。
    rest は fight 指定として残った引数。

    第1引数がレポートとして読めなければ消費しない。
    これで FFLOGS_REPORT を設定済みの場合の
    `python fflogs_unmitigated.py 12` が従来どおり動く。
    """
    report_code, fight_from_url = (None, None)
    rest = list(argv)

    if rest:
        code, fight = parse_report_input(rest[0])
        if code:
            report_code, fight_from_url = code, fight
            rest = rest[1:]

    if not report_code:
        report_code, env_fight = parse_report_input(os.environ.get("FFLOGS_REPORT", ""))
        if fight_from_url is None:
            fight_from_url = env_fight

    return report_code, rest, fight_from_url


def main():
    report_code, args, fight_from_url = resolve_report(sys.argv[1:])
    if not report_code:
        sys.exit(USAGE)

    token = get_token()
    data = gql(token, REPORT_QUERY, {"code": report_code})["reportData"]["report"]

    actors = {a["id"]: a["name"] for a in data["masterData"]["actors"]}
    abilities = {a["gameID"]: a["name"] for a in data["masterData"]["abilities"]}
    fights = data["fights"]

    print(f'レポート: {data["title"]}  ({report_code})\n')
    print(f'{"id":>4}  {"秒":>7}  {"結果":<6} 戦闘名')
    print("-" * 70)
    for f in fights:
        dur = (f["endTime"] - f["startTime"]) / 1000
        res = "撃破" if f["kill"] else (f'{f.get("fightPercentage", "")}%' if f.get("fightPercentage") is not None else "全滅")
        print(f'{f["id"]:>4}  {dur:>7.1f}  {res:<6} {f["name"]}')

    # URL に #fight=N が付いていれば、それを fight 指定として使う
    if not args and fight_from_url is not None:
        args = [str(fight_from_url)]

    if not args:
        print("\n↑ 出力したい fight の id を引数に渡してください")
        print(f'   例: python fflogs_unmitigated.py {report_code} 12')
        print(f'   全部なら: python fflogs_unmitigated.py {report_code} all')
        print("   URL に #fight=N を付けても指定できます（要クォート）")
        return

    if args == ["all"]:
        targets = fights
    else:
        want = {int(a) for a in args}
        targets = [f for f in fights if f["id"] in want]
        if not want - {f["id"] for f in targets}:
            pass
        else:
            sys.exit(f"見つからない fight id: {sorted(want - {f['id'] for f in targets})}")

    rows = []
    for f in targets:
        print(f'\n取得中: fight {f["id"]} ({f["name"]}) ...', flush=True)
        events = fetch_events(token, report_code, f)
        print(f"  {len(events)} 件")
        for e in events:
            if e.get("type") not in ("damage", "calculateddamage"):
                continue
            buffs = e.get("buffs") or ""
            buff_names = []
            for b in buffs.strip(".").split("."):
                if not b:
                    continue
                bid = int(b)
                buff_names.append(abilities.get(bid) or abilities.get(bid - STATUS_OFFSET) or f"#{bid}")
            rows.append({
                "fight": f["id"],
                "戦闘名": f["name"],
                "経過秒": round((e["timestamp"] - f["startTime"]) / 1000, 2),
                "発動元": actors.get(e.get("sourceID"), f'#{e.get("sourceID")}'),
                "技名": abilities.get(e.get("abilityGameID"), f'#{e.get("abilityGameID")}'),
                "技ID": e.get("abilityGameID"),
                "対象": actors.get(e.get("targetID"), f'#{e.get("targetID")}'),
                "実ダメージ": e.get("amount", 0),
                "素ダメージ": e.get("unmitigatedAmount"),
                "軽減量": e.get("mitigated", 0),
                "バリア吸収": e.get("absorbed", 0),
                "ブロック": e.get("blocked", 0),
                "ヒット種別": e.get("hitType"),
                "DoT": bool(e.get("tick")),
                "対象のバフ": ",".join(buff_names),
            })

    if not rows:
        print("被弾イベントが取れませんでした。")
        return

    out = "fflogs_damage_taken.csv"
    with open(out, "w", newline="", encoding="utf-8-sig") as fp:
        w = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\nCSV を書き出しました: {out}  ({len(rows)} 行)")

    # 技ごとの素ダメージ最大値サマリ
    agg = collections.defaultdict(list)
    for r in rows:
        if r["DoT"]:
            continue
        if r["素ダメージ"]:
            agg[(r["発動元"], r["技名"])].append(r["素ダメージ"])
    print(f'\n{"発動元":<20}{"技名":<26}{"件":>4}{"素ダメ最大":>12}{"素ダメ最小":>12}')
    print("-" * 78)
    for (src, ab), v in sorted(agg.items(), key=lambda x: -max(x[1])):
        print(f"{src:<20}{ab:<26}{len(v):>4}{max(v):>12,}{min(v):>12,}")


if __name__ == "__main__":
    main()
