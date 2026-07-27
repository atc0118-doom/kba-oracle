/**
 * 地方競馬(NAR) 予測スコアリング ロジック v1
 *
 * 方針: ブラックボックスの機械学習モデルではなく、
 * 「なぜその順位になったか」を後から説明できる単純な加点方式にしている。
 * 使うデータは、その日のCSVに既に含まれている各馬の実績集計値のみ
 * (全成績・当競馬場成績・騎手成績・馬体重増減)。
 *
 * スコアが高いほど「勝つ可能性が高い」と予測したことを意味する。
 * model_version = "v1-heuristic" としてpredictionsテーブルに記録し、
 * レース結果確定後にfinish_positionと突き合わせて精度を検証する想定。
 */

// "10-1-3-16" のような文字列(1着-2着-3着-着外の回数)を
// {wins, seconds, thirds, others, total, winRate} に変換する
function parseRecord(str) {
  if (!str) return null;
  const parts = str.split("-").map((s) => parseInt(s, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
  const [wins, seconds, thirds, others] = parts;
  const total = wins + seconds + thirds + others;
  return {
    wins,
    seconds,
    thirds,
    others,
    total,
    winRate: total > 0 ? wins / total : 0,
  };
}

// 騎手成績("1-1-0-1")も同じ形式なのでparseRecordを流用できる

/**
 * entries テーブルの1行 + 元CSVの追加カラム(全成績・当競馬場成績・騎手成績)を
 * 受け取ってスコアを算出する。
 *
 * @param {object} horse - 以下のプロパティを想定
 *   overallRecord: "10-1-3-16" (全成績)
 *   courseRecord: "0-0-1-1" (当競馬場成績)
 *   distanceRecord: "0-0-1-1" (うち当距離成績)
 *   jockeyRecord: "1-1-0-1" (今節の騎手成績)
 *   weightDiff: number|null (馬体重増減)
 */
function computeScore(horse) {
  const overall = parseRecord(horse.overallRecord);
  const course = parseRecord(horse.courseRecord);
  const distance = parseRecord(horse.distanceRecord);
  const jockey = parseRecord(horse.jockeyRecord);

  let score = 0;
  const breakdown = {};

  // 1. 全体の勝率 (重み: 40点満点)
  if (overall) {
    breakdown.overallWinRate = overall.winRate * 40;
    score += breakdown.overallWinRate;
  }

  // 2. 当競馬場での勝率 (重み: 25点満点) - 出走数が少なすぎる場合は信頼度を下げる
  if (course && course.total >= 2) {
    breakdown.courseWinRate = course.winRate * 25;
    score += breakdown.courseWinRate;
  }

  // 3. 当距離での勝率 (重み: 15点満点)
  if (distance && distance.total >= 2) {
    breakdown.distanceWinRate = distance.winRate * 15;
    score += breakdown.distanceWinRate;
  }

  // 4. 騎手の今節成績 (重み: 15点満点)
  if (jockey && jockey.total >= 1) {
    breakdown.jockeyWinRate = jockey.winRate * 15;
    score += breakdown.jockeyWinRate;
  }

  // 5. 馬体重の増減が大きい場合は減点(調子の乱れを示唆する経験則)
  if (horse.weightDiff !== null && horse.weightDiff !== undefined) {
    const absChange = Math.abs(horse.weightDiff);
    if (absChange > 10) {
      breakdown.weightPenalty = -5;
      score += breakdown.weightPenalty;
    }
  }

  return { score: Math.round(score * 100) / 100, breakdown };
}

/**
 * 1レース分の出走馬リストを受け取り、スコア順に並べて
 * predicted_rank(1位, 2位...)を付与する
 */
function rankHorses(horses) {
  const scored = horses.map((h) => ({ ...h, ...computeScore(h) }));
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((h, i) => {
    h.predictedRank = i + 1;
  });
  return scored;
}

module.exports = {
  parseRecord,
  computeScore,
  rankHorses,
  MODEL_VERSION: "v1-heuristic",
};
