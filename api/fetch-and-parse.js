/**
 * 地方競馬(NAR) データ取得・パース プロトタイプ
 *
 * keiba.go.jp のデータダウンロード機能を使う想定。
 * ZIPファイル名に UNIXタイムスタンプが含まれるため、
 * まず対象ページ(本日のレース情報 or 月別開催日程)を取得して
 * ダウンロードリンクのURLを抽出してから叩く2段階構成にしている。
 *
 * 依存パッケージ (package.json に追加して npm install):
 *   - adm-zip   (ZIP展開)
 *   - papaparse (CSVパース。日本語カラム名でも扱いやすい)
 *
 * Vercel Serverless Functionでの実行を想定。
 * NOTE: このコンテナはネットワークアクセスが無効なため未検証。
 *       実行はVercel環境 or ローカルで行うこと。
 */

const AdmZip = require("adm-zip");
const Papa = require("papaparse");

const BASE_URL = "https://www.keiba.go.jp";

// ---- 1. ダウンロードリンクの抽出 -----------------------------------------

/**
 * 「本日のレース情報」ページから、当日ファイル(race/odds)のダウンロードURLを抽出する。
 * ページ内の <a> タグの href から YYYYMMDD_(timestamp)_race.zip / odds.zip を拾う想定。
 * 実際のHTML構造は変わる可能性があるため、セレクタは要調整。
 */
async function getTodayDownloadUrls() {
  const res = await fetch(`${BASE_URL}/KeibaWeb/TodayRaceInfo/TodayRaceInfoTop`);
  if (!res.ok) {
    throw new Error(`ページ取得失敗: ${res.status}`);
  }
  const html = await res.text();

  // href="....YYYYMMDD_1234567890_race.zip" のようなパターンを抽出
  const zipPattern = /href="([^"]+_(?:race|odds)\.zip)"/g;
  const urls = [];
  let match;
  while ((match = zipPattern.exec(html)) !== null) {
    const path = match[1];
    urls.push(path.startsWith("http") ? path : `${BASE_URL}${path}`);
  }

  if (urls.length === 0) {
    // 「取得失敗」と「該当レースなし」を区別する原則:
    // ここでは「本日開催なし」の可能性もあるため、エラーではなく
    // 呼び出し側にnullを返して判断を委ねる
    return null;
  }

  return {
    raceZipUrl: urls.find((u) => u.includes("_race.zip")) || null,
    oddsZipUrl: urls.find((u) => u.includes("_odds.zip")) || null,
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

  // ZIP内に複数CSVが入っている場合があるので全部返す
  const csvFiles = {};
  for (const entry of entries) {
    if (entry.entryName.endsWith(".csv")) {
      csvFiles[entry.entryName] = entry.getData().toString("utf-8");
      // 文字コードがShift-JISの場合は iconv-lite 等でのデコードに変更する必要あり
    }
  }
  return csvFiles;
}

// ---- 3. CSVパース ---------------------------------------------------------

function parseCsv(csvText) {
  const result = Papa.parse(csvText, {
    header: false, // 仕様書のカラムはNo.ベースで名前行が無い可能性があるため一旦false
    skipEmptyLines: true,
  });
  return result.data;
}

// レース一覧の1行をオブジェクトに変換 (仕様書のNo.1-66に対応)
function mapRaceListRow(row) {
  return {
    course: row[0],
    raceDate: row[1],
    raceNo: Number(row[2]),
    postTime: row[3],
    raceType: row[4],
    raceName: row[5],
    surface: row[21], // 芝ダート区分
    turnDirection: row[22], // 回り
    distance: Number(row[23]),
    weather: row[24],
    condition: row[25], // 馬場
    numHorses: Number(row[26]),
    raceClass: row[27], // 条件
  };
}

// 出馬表の1行をオブジェクトに変換 (仕様書のNo.1-36に対応)
function mapHorseListRow(row) {
  return {
    course: row[0],
    raceDate: row[1],
    raceNo: Number(row[2]),
    frameNo: Number(row[3]),
    horseNo: Number(row[5]),
    horseName: row[6],
    sex: row[7],
    age: Number(row[8]),
    jockeyName: row[14],
    jockeyAffiliation: row[15],
    weightCarried: Number(row[16]),
    trainerName: row[18],
    horseWeight: row[22] ? Number(row[22]) : null,
    weightDiff: row[23] ? Number(row[23]) : null,
    finishPosition: row[31] ? Number(row[31]) : null,
    time: row[32],
    popularity: row[34] ? Number(row[34]) : null,
  };
}

// ---- 4. メイン処理 ---------------------------------------------------------

async function main() {
  const urls = await getTodayDownloadUrls();

  if (!urls) {
    console.log("本日は対象データなし(非開催 or ページ構造変更の可能性)");
    return;
  }

  const results = { races: [], entries: [] };

  if (urls.raceZipUrl) {
    const csvFiles = await downloadAndExtractCsv(urls.raceZipUrl);
    for (const [filename, content] of Object.entries(csvFiles)) {
      const rows = parseCsv(content);
      if (filename.includes("racelist")) {
        results.races = rows.map(mapRaceListRow);
      } else if (filename.includes("horselist")) {
        results.entries = rows.map(mapHorseListRow);
      }
    }
  }

  console.log(`レース: ${results.races.length}件, 出走馬: ${results.entries.length}件`);
  return results;
}

module.exports = {
  getTodayDownloadUrls,
  downloadAndExtractCsv,
  parseCsv,
  mapRaceListRow,
  mapHorseListRow,
  main,
};

// Vercel Serverless Function として直接叩く場合はこんな感じ:
// export default async function handler(req, res) {
//   const data = await main();
//   res.status(200).json(data);
// }
