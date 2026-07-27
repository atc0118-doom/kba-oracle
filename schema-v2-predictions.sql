-- entries テーブルに予測ロジック用のカラムを追加
-- (lib/predict.js が使う「全成績」「当競馬場成績」「うち当距離成績」「騎手成績」を
--  文字列のまま保存しておき、予測時にパースする方式にしている)

ALTER TABLE entries ADD COLUMN IF NOT EXISTS overall_record VARCHAR(20);
ALTER TABLE entries ADD COLUMN IF NOT EXISTS course_record VARCHAR(20);
ALTER TABLE entries ADD COLUMN IF NOT EXISTS distance_record VARCHAR(20);
ALTER TABLE entries ADD COLUMN IF NOT EXISTS jockey_record VARCHAR(20);
