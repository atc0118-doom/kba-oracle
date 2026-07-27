/**
 * races / entries テーブルへのUPSERT処理(共通ロジック)。
 *
 * save-to-db.js (夜間・結果確定後) と predict.js (レース前・予測時) の
 * 両方から呼ばれる。races/entriesは「今の時点でのCSVの中身」を
 * そのまま反映するだけなので、いつ呼んでも安全にUPSERTできる。
 * (finish_position等はレース前は空、レース後は値が入る、というだけの違い)
 */

async function upsertRacesAndEntries(client, data) {
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

  const entriesWithId = data.entries
    .map((e) => ({ ...e, race_id: raceIdMap.get(`${e.course}|${e.raceDate}|${e.raceNo}`) }))
    .filter((e) => e.race_id);

  let entriesInserted = 0;
  const chunkSize = 200;
  const columns = [
    "race_id", "horse_no", "frame_no", "horse_name", "sex", "age",
    "jockey_name", "jockey_affiliation", "weight_carried", "trainer_name",
    "horse_weight", "weight_diff", "finish_position", "time_seconds", "popularity",
    "overall_record", "course_record", "distance_record", "jockey_record",
  ];

  for (let i = 0; i < entriesWithId.length; i += chunkSize) {
    const chunk = entriesWithId.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((e, rowIdx) => {
      const rowValues = {
        race_id: e.race_id, horse_no: e.horseNo, frame_no: e.frameNo,
        horse_name: e.horseName, sex: e.sex, age: e.age,
        jockey_name: e.jockeyName, jockey_affiliation: e.jockeyAffiliation,
        weight_carried: e.weightCarried, trainer_name: e.trainerName,
        horse_weight: e.horseWeight, weight_diff: e.weightDiff,
        finish_position: e.finishPosition, time_seconds: null, popularity: e.popularity,
        overall_record: e.overallRecord, course_record: e.courseRecord,
        distance_record: e.distanceRecord, jockey_record: e.jockeyRecord,
      };
      const offset = rowIdx * columns.length;
      const ph = columns.map((_, colIdx) => `$${offset + colIdx + 1}`).join(",");
      columns.forEach((col) => values.push(rowValues[col]));
      return `(${ph})`;
    });

    const sql = `INSERT INTO entries (${columns.join(",")}) VALUES ${placeholders.join(",")}
      ON CONFLICT (race_id, horse_no) DO UPDATE SET
        finish_position = EXCLUDED.finish_position,
        popularity = EXCLUDED.popularity,
        overall_record = EXCLUDED.overall_record,
        course_record = EXCLUDED.course_record,
        distance_record = EXCLUDED.distance_record,
        jockey_record = EXCLUDED.jockey_record`;
    await client.query(sql, values);
    entriesInserted += chunk.length;
  }

  return { raceIdMap, entriesInserted, entriesWithId };
}

module.exports = { upsertRacesAndEntries };
