/**
 * 予測の的中率統計を返すエンドポイント。
 * 日別成績と通算成績の両方を計算する。
 * 読み取り専用(書き込みなし)なので認証は不要。
 */

const { Pool } = require("@neondatabase/serverless");

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

module.exports = async function handler(req, res) {
  const connectionString = getConnectionString();
  if (!connectionString) {
    res.status(500).json({ error: "DB接続文字列が見つかりません" });
    return;
  }

  const pool = new Pool({ connectionString });

  try {
    const client = await pool.connect();
    try {
      // 日別の成績(予測1位の単勝的中率)。結果が確定していないレースは除外。
      // model_versionで絞り込まない: predictは1日1回しか実行しないため、
      // 1日の中で使われるモデルは常に1種類だけになる。
      // (v1→v2切り替え日を境に、過去日はv1、以降はv2のデータが自然に分かれる)
      const dailyResult = await client.query(`
        SELECT
          r.race_date,
          MAX(p.model_version) AS model_version,
          COUNT(*) AS total_races,
          COUNT(*) FILTER (WHERE e.finish_position = 1) AS hits,
          ROUND(100.0 * COUNT(*) FILTER (WHERE e.finish_position = 1) / COUNT(*), 1) AS hit_rate_pct
        FROM predictions p
        JOIN entries e ON e.race_id = p.race_id AND e.horse_no = p.horse_no
        JOIN races r ON r.id = p.race_id
        WHERE p.predicted_rank = 1
          AND e.finish_position IS NOT NULL
        GROUP BY r.race_date
        ORDER BY r.race_date DESC
      `);

      // 通算成績(全モデルバージョン合算)
      const totalResult = await client.query(`
        SELECT
          COUNT(*) AS total_races,
          COUNT(*) FILTER (WHERE e.finish_position = 1) AS hits,
          ROUND(100.0 * COUNT(*) FILTER (WHERE e.finish_position = 1) / NULLIF(COUNT(*), 0), 1) AS hit_rate_pct
        FROM predictions p
        JOIN entries e ON e.race_id = p.race_id AND e.horse_no = p.horse_no
        JOIN races r ON r.id = p.race_id
        WHERE p.predicted_rank = 1
          AND e.finish_position IS NOT NULL
      `);

      res.status(200).json({
        daily: dailyResult.rows,
        total: totalResult.rows[0],
        generatedAt: new Date().toISOString(),
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
