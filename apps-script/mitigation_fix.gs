/**
 * 軽減表ジェネレーター 補正ツール  v1.4
 * ------------------------------------------------------------------
 * ジェネレーターが生成した軽減表シートの Damage 列を、
 * FFLogs V2 API の素ダメージ(unmitigatedAmount)で検算・補正します。
 *
 *   - 種別は「通常攻撃 / 単体 / 複数対象」だけの事実ベース（頭割りなどの推測はしない）
 *   - 対象人数や各回の実測値はメモに残すので、頭割りかどうかは人が判断できる
 *   - 採用値は 1,000 単位で切り上げ（±5%のダメージ乱数への安全マージン）
 *   - 必ず「プレビュー → 選んで適用」の2段階。いきなり書き換えません
 *
 * 【導入】
 *   1. 拡張機能 → Apps Script を開く
 *   2. 左の「ファイル」で ＋ → スクリプト で “新しいファイル” を作り、これを貼って保存
 *      （既存のファイルを上書きしないこと。ジェネレーター本体のコードが消えます）
 *   3. 左の時計アイコン「トリガー」→「トリガーを追加」
 *        実行する関数      : mfBuildMenu
 *        イベントのソース  : スプレッドシートから
 *        イベントの種類    : 起動時
 *      → 保存して権限を承認
 *   4. スプレッドシートを再読み込み
 *      メニューに「軽減表 補正」が出ます（本家の【軽減表拡張機能】も並びます）
 *
 *   ※ onOpen という名前を使っていないのは、ジェネレーター本体の onOpen を
 *      上書きしてしまい、本家のメニューが消えるためです。
 *      同じ理由で、関数名と定数名は全て mf / MF_ を頭に付けて衝突を避けています。
 *   ※ トリガーを登録しない場合は、エディタで mfBuildMenu を手動実行しても
 *      メニューは出ます（そのシートを開いている間だけ有効）。
 *
 * 【使う順番】
 *   ① FFLogs認証を設定      … V2の client_id / client_secret を保存（初回だけ）
 *   ② 補正プレビューを作成  … _CORRECTION シートに差分を出力（シートは変更しない）
 *   ③ 選択した補正を適用    … チェックを入れた行だけ反映
 * ------------------------------------------------------------------
 */

var MF_PREVIEW_SHEET = '_CORRECTION';
var MF_ROUND_UNIT = 1000;        // 採用値の切り上げ単位
var MF_TIME_TOLERANCE = 2.5;     // シート行とログを突き合わせる時の許容秒数
var MF_TANK_JOBS = ['Paladin', 'Warrior', 'DarkKnight', 'Gunbreaker'];
var MF_AA_NAMES = ['攻撃', 'オートアタック', 'attack', 'auto-attack', 'autoattack'];

// 複数対象の技で、どの回の値を採用するか
//   'fullest' = 対象人数が最も多かった回の最大値（既定。人が減った全滅間際の回を拾わない）
//   'max'     = 全ての回を通じての最大値（最も安全側だが過大になりやすい）
var MF_PICK_MODE = 'fullest';

function mfBuildMenu() {
  SpreadsheetApp.getUi()
    .createMenu('軽減表 補正')
    .addItem('① FFLogs認証を設定', 'mfSetupCredentials')
    .addItem('② 補正プレビューを作成', 'mfBuildPreview')
    .addItem('③ 選択した補正を適用', 'mfApplyPreview')
    .addSeparator()
    .addItem('認証情報を消す', 'mfClearCredentials')
    .addToUi();
}

/* ============================== ① 認証 ============================== */

function mfSetupCredentials() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('FFLogs V2 の client_id を入力', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var b = ui.prompt('FFLogs V2 の client_secret を入力', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;

  var p = PropertiesService.getScriptProperties();
  p.setProperty('FFLOGS_ID', a.getResponseText().trim());
  p.setProperty('FFLOGS_SECRET', b.getResponseText().trim());

  try {
    mfGetToken();
    ui.alert('認証に成功しました。②に進んでください。');
  } catch (e) {
    ui.alert('認証に失敗しました。\n\n' + e.message);
  }
}

function mfClearCredentials() {
  PropertiesService.getScriptProperties().deleteProperty('FFLOGS_ID');
  PropertiesService.getScriptProperties().deleteProperty('FFLOGS_SECRET');
  SpreadsheetApp.getUi().alert('認証情報を削除しました。');
}

function mfGetToken() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('FFLOGS_ID'), sec = p.getProperty('FFLOGS_SECRET');
  if (!id || !sec) throw new Error('先に「① FFLogs認証を設定」を実行してください。');

  var res = UrlFetchApp.fetch('https://www.fflogs.com/oauth/token', {
    method: 'post',
    payload: { grant_type: 'client_credentials' },
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + sec) },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('トークン取得に失敗 (' + res.getResponseCode() + ')\n' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText()).access_token;
}

function mfGql(token, query, variables) {
  var res = UrlFetchApp.fetch('https://www.fflogs.com/api/v2/client', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ query: query, variables: variables }),
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('APIエラー (' + res.getResponseCode() + ')\n' + res.getContentText().slice(0, 400));
  }
  var body = JSON.parse(res.getContentText());
  if (body.errors) throw new Error('GraphQLエラー\n' + JSON.stringify(body.errors).slice(0, 400));
  return body.data;
}

/* ============================== ② プレビュー ============================== */

function mfBuildPreview() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();

  var layout = mfDetectLayout(sheet);
  if (!layout) {
    ui.alert('このシートは軽減表シートとして認識できませんでした。\n'
      + '補正したい軽減表シートを開いた状態で実行してください。\n\n現在のシート: ' + sheet.getName());
    return;
  }

  var r = ui.prompt('FFLogsのURL、またはレポートコードを入力\n（例: https://www.fflogs.com/reports/xxxx#fight=9）',
                    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var parsed = mfParseReportInput(r.getResponseText());
  if (!parsed.code) { ui.alert('レポートコードを読み取れませんでした。'); return; }

  var token = mfGetToken();

  if (!parsed.fight) {
    var fights = mfFetchFights(token, parsed.code);
    var list = fights.map(function (f) {
      return '  ' + f.id + ' : ' + f.name + ' (' + Math.round((f.endTime - f.startTime) / 1000) + '秒)';
    }).join('\n');
    var fr = ui.prompt('fight ID を入力してください\n\n' + list, ui.ButtonSet.OK_CANCEL);
    if (fr.getSelectedButton() !== ui.Button.OK) return;
    parsed.fight = parseInt(fr.getResponseText().trim(), 10);
  }

  var data = mfCollectFromLog(token, parsed.code, parsed.fight);
  var abilities = mfClassify(data.instances, data.tankIds);
  var rows = mfMatchToSheet(sheet, layout, abilities);

  mfWritePreview(ss, sheet.getName(), rows);
  ui.alert('プレビューを作成しました。\n\n「' + MF_PREVIEW_SHEET + '」シートを確認し、\n'
    + '反映したい行の「適用」にチェックを入れてから ③ を実行してください。');
}

function mfParseReportInput(s) {
  s = String(s || '').trim();
  var code = null, fight = null;
  var m = s.match(/reports\/([A-Za-z0-9]{10,})/);
  if (m) code = m[1]; else if (/^[A-Za-z0-9]{10,}$/.test(s)) code = s;
  var f = s.match(/fight=(\d+)/);
  if (f) fight = parseInt(f[1], 10);
  return { code: code, fight: fight };
}

function mfFetchFights(token, code) {
  var q = 'query($code:String!){reportData{report(code:$code){fights{id name startTime endTime}}}}';
  return mfGql(token, q, { code: code }).reportData.report.fights;
}

/** FFLogsから被弾イベントを取り、技×インスタンス単位にまとめる */
function mfCollectFromLog(token, code, fightId) {
  var metaQ = 'query($code:String!){reportData{report(code:$code){'
    + 'fights{id name startTime endTime}'
    + 'masterData{actors{id name type subType}}'
    + '}}}';
  var meta = mfGql(token, metaQ, { code: code }).reportData.report;

  var fight = null;
  for (var i = 0; i < meta.fights.length; i++) if (meta.fights[i].id === fightId) fight = meta.fights[i];
  if (!fight) throw new Error('fight ' + fightId + ' が見つかりません。');

  var actors = {}, tankIds = {};
  meta.masterData.actors.forEach(function (a) {
    actors[a.id] = a;
    if (a.type === 'Player' && MF_TANK_JOBS.indexOf(a.subType) >= 0) tankIds[a.id] = true;
  });

  // 日本語名 / 英語名 の両方を用意（シートの技名とどちらでも照合できるように）
  var nameMaps = [];
  [false, true].forEach(function (tr) {
    try {
      var q = 'query($code:String!,$tr:Boolean!){reportData{report(code:$code){'
        + 'masterData(translate:$tr){abilities{gameID name}}}}}';
      var ab = mfGql(token, q, { code: code, tr: tr }).reportData.report.masterData.abilities;
      var m = {};
      ab.forEach(function (x) { m[x.gameID] = x.name; });
      nameMaps.push(m);
    } catch (e) { /* 片方が失敗しても続行 */ }
  });

  var evQ = 'query($code:String!,$fight:Int!,$start:Float!,$end:Float!){reportData{report(code:$code){'
    + 'events(fightIDs:[$fight],dataType:DamageTaken,hostilityType:Friendlies,'
    + 'startTime:$start,endTime:$end,limit:10000){data nextPageTimestamp}}}}';

  var events = [], cursor = fight.startTime, end = fight.endTime, guard = 0;
  while (cursor !== null && cursor < end && guard++ < 40) {
    var page = mfGql(token, evQ, { code: code, fight: fightId, start: cursor, end: end })
      .reportData.report.events;
    if (page.data) events = events.concat(page.data);
    var nxt = page.nextPageTimestamp;
    if (nxt === null || nxt === undefined || nxt <= cursor) break;
    cursor = nxt;
  }

  // 同一ヒットが「スナップショット行」と「実適用行」の2件出るので、
  // 素 = 実 + 吸収 + 軽減 が成立し、かつ吸収・軽減の大きい方を採用する
  var picked = {};
  events.forEach(function (e) {
    if (e.tick) return;
    var u = e.unmitigatedAmount || 0;
    if (!u) return;
    var amount = e.amount || 0, abs = e.absorbed || 0, mit = e.mitigated || 0;
    if (amount + abs + mit !== u) return;
    var t = Math.round((e.timestamp - fight.startTime) / 1000);
    var key = e.abilityGameID + '|' + e.targetID + '|' + t;
    var score = abs + mit;
    if (!picked[key] || score > picked[key].score) {
      picked[key] = { score: score, u: u, t: t, ability: e.abilityGameID,
                      target: e.targetID, source: e.sourceID };
    }
  });

  function abilityName(id) {
    for (var i = 0; i < nameMaps.length; i++) if (nameMaps[i][id]) return nameMaps[i][id];
    return 'ID:' + id;
  }

  // 時刻2秒以内の同一技をひとつのインスタンスにまとめる
  var instances = [];
  Object.keys(picked).forEach(function (k) {
    var p = picked[k];
    var found = null;
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].ability === p.ability && instances[i].source === p.source
          && Math.abs(instances[i].t - p.t) <= 2) { found = instances[i]; break; }
    }
    if (!found) {
      found = { ability: p.ability, name: abilityName(p.ability), source: p.source,
                sourceName: (actors[p.source] && actors[p.source].name) || ('#' + p.source),
                t: p.t, targets: {} };
      instances.push(found);
    }
    found.t = Math.min(found.t, p.t);
    found.targets[p.target] = Math.max(found.targets[p.target] || 0, p.u);
  });
  instances.sort(function (a, b) { return a.t - b.t; });

  return { instances: instances, tankIds: tankIds, actors: actors, nameMaps: nameMaps, fight: fight };
}

/** 技ごとに種別を決め、採用値を出す
 *  種別は推測せず、観測できた事実だけで分ける。
 *    通常攻撃 … 技名が「攻撃」系のもの
 *    単体     … 常に対象が1人
 *    複数対象 … それ以外（頭割りか全体かは判定しない。メモの内訳を見て人が判断する）
 */
function mfClassify(instances, tankIds) {
  // 同名でも発動元が違えば別の技として扱う（ボス本体と雑魚が同じ技名を使うことがある）
  var byName = {};
  instances.forEach(function (ins) {
    var key = ins.name + '\u0001' + ins.source;
    (byName[key] = byName[key] || []).push(ins);
  });

  var result = {};
  Object.keys(byName).forEach(function (groupKey) {
    var list = byName[groupKey].slice().sort(function (x, y) { return x.t - y.t; });
    var name = list[0].name;

    var nonTankVals = [], tankVals = [], maxN = 0, detail = [];

    list.forEach(function (ins) {
      var ids = Object.keys(ins.targets);
      maxN = Math.max(maxN, ids.length);
      var localNonTank = [], localAll = [];
      ids.forEach(function (id) {
        var v = ins.targets[id];
        localAll.push(v);
        if (tankIds[id]) tankVals.push(v); else { nonTankVals.push(v); localNonTank.push(v); }
      });
      detail.push({
        t: ins.t,
        n: ids.length,
        max: Math.max.apply(null, (localNonTank.length ? localNonTank : localAll))
      });
    });

    var gaps = [];
    for (var gi = 1; gi < list.length; gi++) gaps.push(list[gi].t - list[gi - 1].t);
    var medGap = gaps.length ? mfMedian(gaps) : null;

    var kind;
    if (mfIsAutoAttackName(name)) kind = '通常攻撃';
    else if (maxN <= 1) kind = '単体';
    else kind = '複数対象';

    var pick, how;
    if (kind === '通常攻撃') {
      // AAはブロック/受け流しで大きく振れるので最大値ではなく中央値
      pick = mfMedian(nonTankVals.length ? nonTankVals : tankVals);
      how = '中央値';
    } else if (kind === '複数対象' && MF_PICK_MODE === 'fullest') {
      var fullest = null;
      detail.forEach(function (d) { if (!fullest || d.n > fullest.n || (d.n === fullest.n && d.max > fullest.max)) fullest = d; });
      pick = fullest.max;
      how = '対象' + fullest.n + '人の回の最大値';
    } else {
      pick = nonTankVals.length ? Math.max.apply(null, nonTankVals)
                                : Math.max.apply(null, tankVals.concat([0]));
      how = '最大値';
    }

    result[groupKey] = {
      name: name,
      sourceName: list[0].sourceName,
      kind: kind,
      value: mfCeilTo(pick, MF_ROUND_UNIT),
      maxN: maxN,
      samples: nonTankVals.length + tankVals.length,
      medGap: medGap,
      pickedBy: how,
      detail: detail,
      instances: list,
      rawMax: Math.max.apply(null, nonTankVals.concat(tankVals).concat([0]))
    };
  });
  return result;
}

function mfIsAutoAttackName(n) {
  var s = String(n || '').trim();
  if (MF_AA_NAMES.indexOf(s) >= 0) return true;
  return MF_AA_NAMES.indexOf(s.toLowerCase()) >= 0;
}

function mfMedian(arr) {
  if (!arr || !arr.length) return 0;
  var a = arr.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mfCeilTo(v, unit) { return Math.ceil(v / unit) * unit; }

/* ============================== シート解析 ============================== */

function mfDetectLayout(sheet) {
  if (sheet.getMaxRows() < 27 || sheet.getMaxColumns() < 10) return null;
  var scan = sheet.getRange(1, 1, Math.min(30, sheet.getMaxRows()), Math.min(14, sheet.getMaxColumns()))
                  .getDisplayValues();
  var headerRow = -1, col = {};
  for (var r = 0; r < scan.length; r++) {
    var found = {};
    for (var c = 0; c < scan[r].length; c++) {
      var v = String(scan[r][c] || '').trim();
      if (['Phase', 'Total Time', 'Time', 'Action', 'Type', 'Damage'].indexOf(v) >= 0 && !found[v]) {
        found[v] = c + 1;
      }
    }
    if (found['Total Time'] && found['Action'] && found['Damage']) {
      headerRow = r + 1; col = found; break;
    }
  }
  if (headerRow < 0) return null;

  // 「Hit / DoT / tick」の行を探し、その次の行からがデータ
  var dataStart = 27;
  for (var r2 = headerRow; r2 < scan.length; r2++) {
    var joined = scan[r2].join('\u0001');
    if (joined.indexOf('Hit') >= 0 && joined.indexOf('DoT') >= 0) { dataStart = r2 + 2; break; }
  }
  return {
    headerRow: headerRow,
    dataStart: dataStart,
    colTotalTime: col['Total Time'] || 3,
    colTime: col['Time'] || 4,
    colAction: col['Action'] || 5,
    colType: col['Type'] || 6,
    colDamage: col['Damage'] || 8
  };
}

function mfParseTimeToSec(s) {
  s = String(s || '').trim();
  if (!s) return null;
  var neg = s.charAt(0) === '-';
  if (neg) s = s.slice(1);
  var p = s.split(':').map(Number);
  if (p.some(isNaN)) return null;
  var sec = null;
  if (p.length === 2) sec = p[0] * 60 + p[1];
  else if (p.length === 3) sec = (p[2] === 0) ? (p[0] * 60 + p[1]) : (p[0] * 3600 + p[1] * 60 + p[2]);
  return sec === null ? null : (neg ? -sec : sec);
}

/** シートの各行とログのインスタンスを突き合わせる */
function mfMatchToSheet(sheet, layout, abilities) {
  var lastRow = sheet.getLastRow();
  var n = lastRow - layout.dataStart + 1;
  if (n <= 0) return [];

  var vals = sheet.getRange(layout.dataStart, 1, n, Math.max(layout.colDamage, layout.colAction) + 1)
                  .getDisplayValues();

  // インスタンスを時刻順の配列に
  var flat = [];
  Object.keys(abilities).forEach(function (key) {
    var info = abilities[key];
    info.instances.forEach(function (ins) {
      flat.push({ name: info.name, t: ins.t, targets: Object.keys(ins.targets).length, info: info });
    });
  });

  var out = [];
  for (var i = 0; i < n; i++) {
    var rowNum = layout.dataStart + i;
    var tSec = mfParseTimeToSec(vals[i][layout.colTotalTime - 1]);
    if (tSec === null) tSec = mfParseTimeToSec(vals[i][layout.colTime - 1]);
    if (tSec === null || tSec < 0) continue;

    var action = String(vals[i][layout.colAction - 1] || '').trim();
    var curDmgStr = String(vals[i][layout.colDamage - 1] || '').replace(/[, ]/g, '');
    var curDmg = curDmgStr === '' ? null : Number(curDmgStr);
    if (!action) continue;

    // 同時刻の候補
    var cands = flat.filter(function (f) { return Math.abs(f.t - tSec) <= MF_TIME_TOLERANCE; });
    if (!cands.length) continue;

    // ① 技名が一致する候補を最優先、② 次にダメージ値の近さ
    var bare = mfStripTag(action);
    var named = cands.filter(function (c) { return c.name === bare; });
    var pool = named.length ? named : cands;

    var best = pool[0];
    if (curDmg && pool.length > 1) {
      var bestDiff = Infinity;
      pool.forEach(function (c) {
        var d = Math.abs(c.info.rawMax - curDmg) / Math.max(c.info.rawMax, 1);
        if (d < bestDiff) { bestDiff = d; best = c; }
      });
    }
    // 技名も一致せず、元のDamageも空の行は触らない（ギミック名だけの行など）
    if (!named.length && curDmg === null) continue;

    var info = best.info;
    if (!info.value) continue;

    // Action列は技名だけにする（種別はセルのメモとプレビューに出す）
    var newAction = mfStripTag(action);

    var note = mfBuildNote(info, curDmg);
    var changed = (curDmg === null) || (Math.abs(curDmg - info.value) / Math.max(info.value, 1) > 0.01)
                  || (action !== newAction);

    out.push({
      row: rowNum, time: vals[i][layout.colTotalTime - 1] || vals[i][layout.colTime - 1],
      action: action, newAction: newAction,
      cur: curDmg, next: info.value, kind: info.kind,
      maxN: info.maxN, samples: info.samples, note: note,
      colAction: layout.colAction, colDamage: layout.colDamage,
      changed: changed
    });
  }
  return out;
}

function mfStripTag(s) { return String(s).replace(/【[^】]*】\s*$/, '').trim(); }

function mfBuildNote(info, curDmg) {
  var lines = [];
  lines.push('種別: ' + info.kind + (info.sourceName ? '   発動元: ' + info.sourceName : ''));
  lines.push('実測: ' + info.samples + '件 / 最大 ' + mfFmt(info.rawMax)
    + (info.medGap !== null && info.medGap !== undefined ? ' / 発動間隔 約' + info.medGap + '秒' : ''));
  lines.push('採用: ' + info.pickedBy + ' → 1,000単位で切り上げ');
  if (info.detail && info.detail.length) {
    if (info.kind === '通常攻撃') {
      // AAは回数が多いので一覧ではなく散らばりだけ出す
      var vs = info.detail.map(function (x) { return x.max; });
      lines.push('内訳: ' + info.detail.length + '回 / 最小 ' + mfFmt(Math.min.apply(null, vs))
        + ' / 中央 ' + mfFmt(mfMedian(vs)) + ' / 最大 ' + mfFmt(Math.max.apply(null, vs)));
    } else {
      var d = info.detail.slice(0, 12).map(function (x) {
        return mfMmss(x.t) + ' ' + x.n + '人 ' + mfFmt(x.max);
      });
      lines.push('内訳(時刻/対象数/最大): ' + d.join('  |  ')
        + (info.detail.length > 12 ? '  … 他' + (info.detail.length - 12) + '回' : ''));
    }
  }
  if (curDmg) lines.push('補正前: ' + mfFmt(curDmg));
  return lines.join('\n');
}

function mfMmss(sec) {
  var m = Math.floor(sec / 60), s2 = sec % 60;
  return m + ':' + (s2 < 10 ? '0' : '') + s2;
}

function mfFmt(v) { return Number(v).toLocaleString('en-US'); }

/* ============================== プレビュー出力 ============================== */

function mfWritePreview(ss, targetName, rows) {
  var sh = ss.getSheetByName(MF_PREVIEW_SHEET);
  if (sh) sh.clear(); else sh = ss.insertSheet(MF_PREVIEW_SHEET);

  var header = ['適用', '対象シート', '行', '時刻', '技名', '→ 新しい技名',
                '現在のDamage', '→ 新Damage', '差', '種別', '最大対象数', 'サンプル', 'メモ内容'];
  var data = [header];

  rows.forEach(function (r) {
    data.push([
      r.changed, targetName, r.row, r.time, r.action, r.newAction,
      r.cur === null ? '' : r.cur, r.next,
      (r.cur === null ? '' : (r.next - r.cur)),
      r.kind, r.maxN || '', r.samples, r.note.replace(/\n/g, ' / ')
    ]);
  });

  if (data.length === 1) data.push([false, targetName, '', '', '(一致する行がありませんでした)', '', '', '', '', '', '', '', '']);

  if (sh.getMaxColumns() < header.length) sh.insertColumnsAfter(sh.getMaxColumns(), header.length - sh.getMaxColumns());
  if (sh.getMaxRows() < data.length) sh.insertRowsAfter(sh.getMaxRows(), data.length - sh.getMaxRows());

  sh.getRange(1, 1, data.length, header.length).setValues(data);
  if (data.length > 1) sh.getRange(2, 1, data.length - 1, 1).insertCheckboxes();
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sh.autoResizeColumns(2, 10);
  ss.setActiveSheet(sh);
}

/* ============================== ③ 適用 ============================== */

function mfApplyPreview() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(MF_PREVIEW_SHEET);
  if (!sh) { ui.alert('先に「② 補正プレビューを作成」を実行してください。'); return; }

  var last = sh.getLastRow();
  if (last < 2) { ui.alert('プレビューが空です。'); return; }
  var vals = sh.getRange(2, 1, last - 1, 13).getValues();

  var picked = vals.filter(function (v) { return v[0] === true && v[2]; });
  if (!picked.length) { ui.alert('「適用」にチェックが入った行がありません。'); return; }

  var res = ui.alert('確認', picked.length + ' 行を書き換えます。よろしいですか？\n'
    + '（対象シート: ' + picked[0][1] + '）', ui.ButtonSet.OK_CANCEL);
  if (res !== ui.Button.OK) return;

  var target = ss.getSheetByName(picked[0][1]);
  if (!target) { ui.alert('対象シートが見つかりません: ' + picked[0][1]); return; }
  var layout = mfDetectLayout(target);
  if (!layout) { ui.alert('対象シートの構造を認識できませんでした。'); return; }

  var applied = 0;
  picked.forEach(function (v) {
    var row = Number(v[2]);
    var newAction = v[5], newDmg = Number(v[7]), note = String(v[12]).replace(/ \/ /g, '\n');
    if (!row || !newDmg) return;
    var aCell = target.getRange(row, layout.colAction);
    aCell.setValue(newAction);
    aCell.setNote(note);
    target.getRange(row, layout.colDamage).setValue(newDmg);
    applied++;
  });

  ui.alert('完了: ' + applied + ' 行を更新しました。\n技名セルにマウスを乗せると内訳のメモが出ます。');
}
