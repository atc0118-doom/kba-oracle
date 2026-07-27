/**
 * 地方競馬(NAR) データ取得・パース 共通ロジック
 *
 * api/fetch-and-parse.js (確認用) と api/save-to-db.js (DB保存用) の
 * 両方から呼ばれる共通部分をここに切り出している。
 *
 * 判明済み仕様:
 *   - ダウンロードURLは固定URL(下記定数)へのGETアクセスで取得できる
 *   - CSVはヘッダー行あり(1行目に日本語の項目名)、UTF-8(BOM付き)
 *   - race.zip の中には racelist.csv / horselist.csv / payback.csv
 *   - odds.zip の中には odds.csv
 *
 * 依存パッケージ: adm-zip, papaparse
 */

const AdmZip = require("adm-zip");
const Papa = require("papaparse");

const RACE_ZIP_URL = "https://www.keiba.go.jp/KeibaWeb/DataDownload/RaceDataDownload?type=daily";
const ODDS_ZIP_URL = "https://www.keiba.go.jp/KeibaWeb/DataDownload/OddsDataDownload?type=daily";

// ---- ZIPダウンロード & CSV抽出 --------------------------------------------

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
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1); // BOM除去
      }
      csvFiles[entry.entryName] = text;
    }
  }
  return csvFiles;
}

// ---- CSVパース(ヘッダー行あり) ---------------------------------------------

function parseCsv(csvText) {
  const result = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return result.data;
}

// ---- 各CSVの行 → アプリ内オブジェクトへの変換 ------------------------------

function toIsoDate(yyyymmdd) {
  // "20260727" -> "2026-07-27"
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function mapRaceListRow(row) {
  return {
    course: row["競馬場"],
    raceDate: toIsoDate(row["競走年月日"]),
    raceNo: Number(row["レース番号"]),
    postTime: row["発走時刻"],
    raceName: row["レース名"],
    raceClass: row["条件"],
    surface: row["芝ダート区分"],
    turnDirection: row["回り"],
    distance: row["距離"] ? Number(row["距離"]) : null,
    weather: row["天候"] || null,
    condition: row["馬場"] || null,
    numHorses: row["頭数"] ? Number(row["頭数"]) : null,
  };
}

function mapHorseListRow(row) {
  return {
    course: row["競馬場"],
    raceDate: toIsoDate(row["競走年月日"]),
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
    time: row["タイム"] || null,
    popularity: row["人気"] ? Number(row["人気"]) : null,
  };
}

function mapOddsRow(row) {
  return {
    course: row["競馬場"],
    raceDate: toIsoDate(row["競走年月日"]),
    raceNo: Number(row["レース番号"]),
    betType: row["賭式"],
    numbers: [row["番号1"], row["番号2"], row["番号3"]].filter(Boolean).join("-"),
    oddsValue: row["オッズ"] ? Number(row["オッズ"]) : null,
    popularity: row["人気"] ? Number(row["人気"]) : null,
  };
}

function mapPaybackRow(row) {
  const base = {
    course: row["競馬場"],
    raceDate: toIsoDate(row["競走年月日"]),
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
  return payouts;
}

// ---- メイン処理 -------------------------------------------------------------

async function fetchTodayData() {
  const results = { races: [], entries: [], odds: [], payouts: [] };

  const raceCsvFiles = await downloadAndExtractCsv(RACE_ZIP_URL);
  for (const [filename, content] of Object.entries(raceCsvFiles)) {
    const rows = parseCsv(content);
    if (filename.includes("racelist")) {
      results.races = rows.map(mapRaceListRow);
    } else if (filename.includes("horselist")) {
      results.entries = rows.map(mapHorseListRow);
    } else if (filename.includes("payback")) {
      results.payouts = rows.flatMap(mapPaybackRow);
    }
  }

  const oddsCsvFiles = await downloadAndExtractCsv(ODDS_ZIP_URL);
  for (const [filename, content] of Object.entries(oddsCsvFiles)) {
    if (filename.includes("odds")) {
      const rows = parseCsv(content);
      results.odds = rows.map(mapOddsRow);
    }
  }

  return results;
}

module.exports = {
  fetchTodayData,
  parseCsv,
  mapRaceListRow,
  mapHorseListRow,
  mapOddsRow,
  mapPaybackRow,
  toIsoDate,
};
