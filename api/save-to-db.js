/**
 * 取得したデータをNeon(Postgres)に保存するエンドポイント。
 *
 * 注意点:
 * - オッズは1日で数万件になるため、1件ずつINSERTすると遅すぎる。
 *   まとめて書き込む(バルクインサート)方式にしている。
 * - races は (source, course, race_date, race_no) の一意制約で
 *   UPSERT(既にあれば更新、無ければ追加)している。
 * - entries は (race_id, horse_no) の一意制約でUPSERTしている。
 * - odds / payouts には一意制約を付けていないため、同じ日に何度も
 *   このエンドポイントを叩くと重複が増える。再実行する場合は
 *   事前にその日のoddsレコードを消してから叩くなどの運用が必要
 *   (プロトタイプ段階のため、重複防止は今後の課題としている)。
 *
 * 環境変数: Neon Integrationで自動追加された接続文字列を使う。
 * 変数名はプレフィックス設定により変わるため、複数の候補名を試す。
 */

const { Pool } = require("@neondatabase/serverless");
const { fetchTodayData } = require("../lib/nar-data.js");

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

// INSERT文をチャンク(分割)しながらまとめて実行するヘルパー
async function bulkInsert(client, table, columns, rows, chunkSize, conflictClause) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, rowIdx) => {
      const offset = rowIdx * columns.length;
      const ph = columns.map((_, colIdx) => `$${offset + colIdx + 1}`).join(",");
      columns.forEach((col) => values.push(row[col]));
      return `(${ph})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders.join(",")} ${conflictClause || ""}`;
    await client.query(sql, values);
    inserted += chunk.length;
  }
  return inserted;
}

module.exports = async function handler(req, res) {
  const connectionString = getConnectionString();
  if (!connectionString) {
    res.status(500).json({
      error: "DB接続文字列が見つかりません。Vercelの環境変数名を確認してください。",
      checkedNames: [
        "STORAGE_DATABASE_URL",
        "STORAGE_POSTGRES_URL",
        "DATABASE_URL",
        "POSTGRES_URL",
        "STORAGE_URL",
      ],
    });
    return;
  }

  const pool = new Pool({ connectionString });

  try {
    const data = await fetchTodayData();
    const client = await pool.connect();

    try {
      // 1. races を UPSERT して race_id マップを作る
      const raceIdMap = new Map(); // key: "course|raceDate|raceNo" -> id
      for (const r of data.races) {
        const result = await client.query(
          `INSERT INTO races
            (source, course, race_date, race_no, post_time, race_name, race_class,
             surface, turn_direction, distance, weather, condition, num_horses)
           VALUES ('NAR',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (source, course, race_date, race_no)
           DO UPDATE SET
             post_time = EXCLUDED.post_time,
             race_name = EXCLUDED.race_name,
             race_class = EXCLUDED.race_class,
             surface = EXCLUDED.surface,
             turn_direction = EXCLUDED.turn_direction,
             distance = EXCLUDED.distance,
             weather = EXCLUDED.weather,
             condition = EXCLUDED.condition,
             num_horses = EXCLUDED.num_horses
           RETURNING id`,
          [
            r.course, r.raceDate, r.raceNo, r.postTime, r.raceName, r.raceClass,
            r.surface, r.turnDirection, r.distance, r.weather, r.condition, r.numHorses,
          ]
        );
        raceIdMap.set(`${r.course}|${r.raceDate}|${r.raceNo}`, result.rows[0].id);
      }

      // 2. entries / odds / payouts に race_id を付与
      const entriesWithId = data.entries
        .map((e) => ({ ...e, race_id: raceIdMap.get(`${e.course}|${e.raceDate}|${e.raceNo}`) }))
        .filter((e) => e.race_id);

      const oddsWithId = data.odds
        .map((o) => ({ ...o, race_id: raceIdMap.get(`${o.course}|${o.raceDate}|${o.raceNo}`) }))
        .filter((o) => o.race_id);

      const payoutsWithId = data.payouts
        .map((p) => ({ ...p, race_id: raceIdMap.get(`${p.course}|${p.raceDate}|${p.raceNo}`) }))
        .filter((p) => p.race_id);

      // 3. entries をバルクUPSERT
      const entriesInserted = await bulkInsert(
        client,
        "entries",
        ["race_id", "horse_no", "frame_no", "horse_name", "sex", "age",
         "jockey_name", "jockey_affiliation", "weight_carried", "trainer_name",
         "horse_weight", "weight_diff", "finish_position", "time_seconds", "popularity"],
        entriesWithId.map((e) => ({
          race_id: e.race_id, horse_no: e.horseNo, frame_no: e.frameNo,
          horse_name: e.horseName, sex: e.sex, age: e.age,
          jockey_name: e.jockeyName, jockey_affiliation: e.jockeyAffiliation,
          weight_carried: e.weightCarried, trainer_name: e.trainerName,
          horse_weight: e.horseWeight, weight_diff: e.weightDiff,
          finish_position: e.finishPosition, time_seconds: null, popularity: e.popularity,
        })),
        200,
        "ON CONFLICT (race_id, horse_no) DO UPDATE SET finish_position = EXCLUDED.finish_position, popularity = EXCLUDED.popularity"
      );

      // 4. odds をバルクINSERT(一意制約なし、単純追加)
      const oddsInserted = await bulkInsert(
        client,
        "odds",
        ["race_id", "bet_type", "numbers", "odds_value", "popularity"],
        oddsWithId.map((o) => ({
          race_id: o.race_id, bet_type: o.betType, numbers: o.numbers,
          odds_value: o.oddsValue, popularity: o.popularity,
        })),
        500,
        ""
      );

      // 5. payouts をバルクINSERT(一意制約なし、単純追加)
      const payoutsInserted = await bulkInsert(
        client,
        "payouts",
        ["race_id", "bet_type", "winning_numbers", "payout_amount", "popularity"],
        payoutsWithId.map((p) => ({
          race_id: p.race_id, bet_type: p.betType, winning_numbers: p.winningNumbers,
          payout_amount: p.payoutAmount, popularity: p.popularity,
        })),
        500,
        ""
      );

      res.status(200).json({
        races: data.races.length,
        entries: entriesInserted,
        odds: oddsInserted,
        payouts: payoutsInserted,
      });
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
