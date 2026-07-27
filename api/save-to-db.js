/**
 * 取得したデータをNeon(Postgres)に保存するエンドポイント。
 *
 * セキュリティ:
 * - このエンドポイントは誰でもURLを知っていれば叩けてしまうため、
 *   Vercelの環境変数 CRON_SECRET を設定すると、Vercel Cronからの
 *   呼び出し以外は拒否するようになる(Authorizationヘッダーを検証)。
 *   CRON_SECRETが未設定の場合はチェックをスキップする(動作確認用)。
 *
 * 重複防止:
 * - races は (source, course, race_date, race_no) の一意制約でUPSERT。
 * - entries は (race_id, horse_no) の一意制約でUPSERT。
 * - odds / payouts には一意制約が付けにくいため、対象レースの
 *   既存レコードを一旦DELETEしてから入れ直す方式で、同じ日に
 *   何度実行しても重複しないようにしている。
 *
 * パフォーマンス:
 * - オッズは1日で数万件になるため、1件ずつINSERTすると遅すぎる。
 *   まとめて書き込む(バルクインサート)方式にしている。
 *
 * 環境変数: Neon Integrationで自動追加された接続文字列を使う。
 * 変数名はプレフィックス設定により変わるため、複数の候補名を試す。
 */

const { Pool } = require("@neondatabase/serverless");
const { fetchTodayData } = require("../lib/nar-data.js");
const { upsertRacesAndEntries } = require("../lib/db-helpers.js");

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // 未設定なら動作確認用にチェックをスキップ
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${secret}`;
}

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
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "認証エラー: このエンドポイントはCron専用です" });
    return;
  }

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
      // 1〜3. races / entries を共通関数でUPSERT
      const { raceIdMap, entriesInserted } = await upsertRacesAndEntries(client, data);

      // odds / payouts に race_id を付与
      const oddsWithId = data.odds
        .map((o) => ({ ...o, race_id: raceIdMap.get(`${o.course}|${o.raceDate}|${o.raceNo}`) }))
        .filter((o) => o.race_id);

      const payoutsWithId = data.payouts
        .map((p) => ({ ...p, race_id: raceIdMap.get(`${p.course}|${p.raceDate}|${p.raceNo}`) }))
        .filter((p) => p.race_id);

      // 重複防止: 今回対象になったレースの既存odds/payoutsを一旦削除してから入れ直す
      const targetRaceIds = [...raceIdMap.values()];
      if (targetRaceIds.length > 0) {
        await client.query(`DELETE FROM odds WHERE race_id = ANY($1::int[])`, [targetRaceIds]);
        await client.query(`DELETE FROM payouts WHERE race_id = ANY($1::int[])`, [targetRaceIds]);
      }

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
