/**
 * その日のレースについて予測スコアを計算し、predictionsテーブルに保存するエンドポイント。
 *
 * 重要な設計上の注意:
 * save-to-db(深夜・結果確定後)より前、レース開始前の時間帯に実行する想定。
 * そのため、DBに既にその日のraces/entriesがある前提にはできず、
 * このエンドポイント自身がkeiba.go.jpから最新データを取得し、
 * races/entriesをUPSERTしてから予測スコアを計算する。
 * (finish_position等はレース前は空のまま入る。夜にsave-to-dbが
 *  実行されると、同じUPSERTで結果が上書きされる)
 *
 * 同日に複数回実行しても重複しないよう、対象レースの既存predictions
 * (同じmodel_version分)を一旦削除してから入れ直す。
 */

const { Pool } = require("@neondatabase/serverless");
const { fetchTodayData } = require("../lib/nar-data.js");
const { upsertRacesAndEntries } = require("../lib/db-helpers.js");
const { rankHorses, MODEL_VERSION } = require("../lib/predict.js");

function getConnectionString() {
  const candidates = [
    "STORAGE_DATABASE_URL",
    "STORAGE_POSTGRES_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
    "STORAGE_URL",
  ];
  for (const name of candidates) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "認証エラー: このエンドポイントはCron専用です" });
    return;
  }

  const connectionString = getConnectionString();
  if (!connectionString) {
    res.status(500).json({ error: "DB接続文字列が見つかりません" });
    return;
  }

  const pool = new Pool({ connectionString });

  try {
    const data = await fetchTodayData();
    const client = await pool.connect();

    try {
      // races/entriesを最新化(まだ無ければ新規作成、あれば更新)
      const { raceIdMap } = await upsertRacesAndEntries(client, data);

      if (raceIdMap.size === 0) {
        res.status(200).json({ message: "本日は対象レースがありません", predictions: 0 });
        return;
      }

      // race_idごとにグループ化して予測スコアを計算
      const byRaceId = new Map();
      for (const e of data.entries) {
        const raceId = raceIdMap.get(`${e.course}|${e.raceDate}|${e.raceNo}`);
        if (!raceId) continue;
        if (!byRaceId.has(raceId)) byRaceId.set(raceId, []);
        byRaceId.get(raceId).push({
          horseNo: e.horseNo,
          overallRecord: e.overallRecord,
          courseRecord: e.courseRecord,
          distanceRecord: e.distanceRecord,
          jockeyRecord: e.jockeyRecord,
          weightDiff: e.weightDiff,
        });
      }

      const predictionRows = [];
      for (const [raceId, horses] of byRaceId.entries()) {
        const ranked = rankHorses(horses);
        for (const h of ranked) {
          predictionRows.push({
            race_id: raceId,
            horse_no: h.horseNo,
            model_version: MODEL_VERSION,
            predicted_score: h.score,
            predicted_rank: h.predictedRank,
          });
        }
      }

      // 重複防止: 対象レース×このモデルバージョンの既存予測を削除してから入れ直す
      const raceIds = [...byRaceId.keys()];
      await client.query(
        `DELETE FROM predictions WHERE race_id = ANY($1::int[]) AND model_version = $2`,
        [raceIds, MODEL_VERSION]
      );

      for (const p of predictionRows) {
        await client.query(
          `INSERT INTO predictions (race_id, horse_no, model_version, predicted_score, predicted_rank)
           VALUES ($1,$2,$3,$4,$5)`,
          [p.race_id, p.horse_no, p.model_version, p.predicted_score, p.predicted_rank]
        );
      }

      res.status(200).json({ races: byRaceId.size, predictions: predictionRows.length });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, stack: err.stack });
  } finally {
    await pool.end();
  }
};

