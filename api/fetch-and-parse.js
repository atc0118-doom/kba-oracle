/**
 * 地方競馬(NAR) データ取得・パース プロトタイプ v2
 *
 * 実際にダウンロードしたZIP(20260727_race.zip / odds.zip)の中身を確認して判明した仕様:
 *   - CSVはヘッダー行あり(1行目に日本語の項目名)
 *   - 文字コードはUTF-8 (BOM付き)
 *   - race.zip の中には racelist.csv / horselist.csv / payback.csv の3つが入っている
 *   - odds.zip の中には odds.csv が1つ入っている
 *
 * ダウンロードURLは固定URLへのGETアクセスで取得できることが判明済み(2026/07/27確認):
 *   レース情報: https://www.keiba.go.jp/KeibaWeb/DataDownload/RaceDataDownload?type=daily
 *   オッズ情報: https://www.keiba.go.jp/KeibaWeb/DataDownload/OddsDataDownload?type=daily
 * ページのHTML解析(スクレイピング)は一切不要。
 *
 * 依存パッケージ: adm-zip, papaparse
 */

const AdmZip = require("adm-zip");
const Papa = require("papaparse");

// ---- 1. ダウンロードURL -----------------------------------------------
// ページスクレイピングは不要だった。固定URLに直接アクセスするだけで
// 当日分のZIPが返ってくる仕様と判明(2026/07/27 実機確認済み)。
const RACE_ZIP_URL = "https://www.keiba.go.jp/KeibaWeb/DataDownload/RaceDataDownload?type=daily";
const ODDS_ZIP_URL = "https://www.keiba.go.jp/KeibaWeb/DataDownload/OddsDataDownload?type=daily";

async function getTodayDownloadUrls() {
  // 固定URLなのでページを叩いて抽出する必要がない
  return {
    raceZipUrl: RACE_ZIP_URL,
    oddsZipUrl: ODDS_ZIP_URL,
  };
}

// ---- 2. ZIPダウンロード & CSV抽出 ----------------------------------------

async function downloadAndExtractCsv(zipUrl) {
  const res = await fetch(zipUrl);
  if (!res.ok) {
    throw new Error(`ZIP取得失敗: ${res.status} (${zipUrl})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const csvFiles = {};
  for (const entry of entries) {
    if (entry.entryName.endsWith(".csv")) {
      let text = entry.getData().toString("utf-8");
      // UTF-8 BOM除去
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
      csvFiles[entry.entryName] = text;
    }
  }
  return csvFiles;
}

// ---- 3. CSVパース(ヘッダー行あり) ------------------------------------------

function parseCsv(csvText) {
  const result = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return result.data;
}

// ---- 4. 各CSVの行 → アプリ内オブジェクトへの変換 ---------------------------
// カラム名は実際にダウンロードしたCSVのヘッダーと完全一致させている

function mapRaceListRow(row) {
  return {
    course: row["競馬場"],
    raceDate: row["競走年月日"],
    raceNo: Number(row["レース番号"]),
    postTime: row["発走時刻"],
    raceType: row["競走種類名称"],
    raceName: row["レース名"],
    surface: row["芝ダート区分"],
    turnDirection: row["回り"],
    distance: row["距離"] ? Number(row["距離"]) : null,
    weather: row["天候"],
    condition: row["馬場"],
    numHorses: row["頭数"] ? Number(row["頭数"]) : null,
    raceClass: row["条件"],
  };
}

function mapHorseListRow(row) {
  return {
    course: row["競馬場"],
    raceDate: row["競走年月日"],
    raceNo: Number(row["レース番号"]),
    frameNo: row["枠番"] ? Number(row["枠番"]) : null,
    horseNo: Number(row["馬番"]),
    horseName: row["馬名"],
    sex: row["性"],
    age: row["齢"] ? Number(row["齢"]) : null,
    jockeyName: row["騎手名"],
    jockeyAffiliation: row["騎手所属"],
    weightCarried: row["負担重量"] ? Number(row["負担重量"]) : null,
    trainerName: row["調教師"],
    horseWeight: row["馬体重"] ? Number(row["馬体重"]) : null,
    weightDiff: row["馬体重増減"] ? Number(row["馬体重増減"]) : null,
    finishPosition: row["着順"] ? Number(row["着順"]) : null,
    time: row["タイム"],
    popularity: row["人気"] ? Number(row["人気"]) : null,
  };
}

function mapOddsRow(row) {
  return {
    course: row["競馬場"],
    raceDate: row["競走年月日"],
    raceNo: Number(row["レース番号"]),
    betType: row["賭式"],
    numbers: [row["番号1"], row["番号2"], row["番号3"]].filter(Boolean).join("-"),
    oddsValue: row["オッズ"] ? Number(row["オッズ"]) : null,
    popularity: row["人気"] ? Number(row["人気"]) : null,
  };
}

function mapPaybackRow(row) {
  // 払戻金CSVは券種ごとに列が横並びになっているため、
  // 券種別の配列に展開してDBのpayoutsテーブル構造(1行=1券種)に合わせる
  const base = {
    course: row["競馬場"],
    raceDate: row["競走年月日"],
    raceNo: Number(row["レース番号"]),
  };
  const payouts = [];

  if (row["単勝組番"]) {
    payouts.push({
      ...base,
      betType: "単勝",
      winningNumbers: row["単勝組番"],
      payoutAmount: Number(row["単勝払戻金（円）"]),
      popularity: Number(row["単勝人気"]),
    });
  }
  for (let i = 1; i <= 3; i++) {
    if (row[`複勝組番${i}`]) {
      payouts.push({
        ...base,
        betType: "複勝",
        winningNumbers: row[`複勝組番${i}`],
        payoutAmount: Number(row[`複勝払戻金${i}（円）`]),
        popularity: Number(row[`複勝人気${i}`]),
      });
    }
  }
  if (row["３連単組番馬番1"]) {
    payouts.push({
      ...base,
      betType: "3連単",
      winningNumbers: `${row["３連単組番馬番1"]}-${row["３連単組番馬番2"]}-${row["３連単組番馬番3"]}`,
      payoutAmount: Number(row["３連単払戻金（円）"]),
      popularity: Number(row["３連単人気"]),
    });
  }
  // 他の券種(枠複/枠単/馬複/馬単/ワイド/3連複)も同様に追加可能。
  // 最小構成として単勝・複勝・3連単のみ実装している。

  return payouts;
}

// ---- 5. メイン処理 ---------------------------------------------------------

async function main() {
  const urls = await getTodayDownloadUrls();

  if (!urls) {
    return {
      message: "ダウンロードURL未特定(getTodayDownloadUrlsが未実装)",
      races: [],
      entries: [],
      odds: [],
      payouts: [],
    };
  }

  const results = { races: [], entries: [], odds: [], payouts: [] };

  if (urls.raceZipUrl) {
    const csvFiles = await downloadAndExtractCsv(urls.raceZipUrl);
    for (const [filename, content] of Object.entries(csvFiles)) {
      const rows = parseCsv(content);
      if (filename.includes("racelist")) {
        results.races = rows.map(mapRaceListRow);
      } else if (filename.includes("horselist")) {
        results.entries = rows.map(mapHorseListRow);
      } else if (filename.includes("payback")) {
        results.payouts = rows.flatMap(mapPaybackRow);
      }
    }
  }

  if (urls.oddsZipUrl) {
    const csvFiles = await downloadAndExtractCsv(urls.oddsZipUrl);
    for (const [filename, content] of Object.entries(csvFiles)) {
      if (filename.includes("odds")) {
        const rows = parseCsv(content);
        results.odds = rows.map(mapOddsRow);
      }
    }
  }

  return results;
}

// ---- Vercel Serverless Function のエントリーポイント ----------------------
async function handler(req, res) {
  try {
    const data = await main();
    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}

module.exports = handler;
module.exports.parseCsv = parseCsv;
module.exports.mapRaceListRow = mapRaceListRow;
module.exports.mapHorseListRow = mapHorseListRow;
module.exports.mapOddsRow = mapOddsRow;
module.exports.mapPaybackRow = mapPaybackRow;
