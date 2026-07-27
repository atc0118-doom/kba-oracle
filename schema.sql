-- 地方競馬(NAR) 予測・答え合わせ用スキーマ プロトタイプ
-- 中央競馬(JRA)を後で追加する前提で course テーブルに source 区分を持たせている

CREATE TABLE races (
    id              SERIAL PRIMARY KEY,
    source          VARCHAR(10) NOT NULL DEFAULT 'NAR', -- 'NAR' | 'JRA'
    course          VARCHAR(20) NOT NULL,                -- 大井, 川崎 等
    race_date       DATE NOT NULL,
    race_no         SMALLINT NOT NULL,
    post_time       VARCHAR(4),                          -- HHMM
    race_name       TEXT,
    race_class      VARCHAR(50),                         -- 条件(サラブレッド系3歳以上等)
    surface         VARCHAR(10),                         -- 芝 | ダート
    turn_direction  VARCHAR(5),                           -- 右 | 左
    distance        SMALLINT,
    weather         VARCHAR(10),
    condition       VARCHAR(10),                          -- 馬場状態(良/稍重/重/不良)
    num_horses      SMALLINT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (source, course, race_date, race_no)
);

CREATE TABLE entries (
    id                SERIAL PRIMARY KEY,
    race_id           INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    horse_no          SMALLINT NOT NULL,
    frame_no          SMALLINT,
    horse_name        VARCHAR(50) NOT NULL,
    sex               VARCHAR(5),
    age               SMALLINT,
    jockey_name       VARCHAR(50),
    jockey_affiliation VARCHAR(20),
    weight_carried    NUMERIC(4,1),
    trainer_name      VARCHAR(50),
    horse_weight      SMALLINT,
    weight_diff       SMALLINT,
    -- 以下は結果確定後に更新される項目 (予測時点ではNULL)
    finish_position   SMALLINT,
    time_seconds      NUMERIC(6,2),
    last_3f           NUMERIC(4,1),
    popularity        SMALLINT,          -- 実際の人気(結果)
    UNIQUE (race_id, horse_no)
);

CREATE TABLE odds (
    id           SERIAL PRIMARY KEY,
    race_id      INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    bet_type     VARCHAR(10) NOT NULL,   -- 単勝, 複勝, 馬連, 3連単 等
    numbers      VARCHAR(20) NOT NULL,   -- "10" や "10-5-1" のような組番文字列
    odds_value   NUMERIC(8,1),
    popularity   SMALLINT,
    is_final     BOOLEAN DEFAULT false,  -- 確定オッズかどうか(中間オッズと区別)
    fetched_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE payouts (
    id             SERIAL PRIMARY KEY,
    race_id        INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    bet_type       VARCHAR(10) NOT NULL,
    winning_numbers VARCHAR(20) NOT NULL,
    payout_amount  INTEGER NOT NULL,
    popularity     SMALLINT
);

-- ---- 予測・答え合わせ用テーブル(ORACLE同様の思想) --------------------------

CREATE TABLE predictions (
    id           SERIAL PRIMARY KEY,
    race_id      INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    horse_no     SMALLINT NOT NULL,
    model_version VARCHAR(20),           -- どのモデル/ロジックの予測か記録
    predicted_score NUMERIC(6,3),        -- モデルが出した評価値・確率等
    predicted_rank  SMALLINT,            -- 予測順位
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- 答え合わせビュー: 予測 vs 実際の着順・払戻を突合
CREATE VIEW prediction_results AS
SELECT
    p.id AS prediction_id,
    r.source, r.course, r.race_date, r.race_no,
    p.horse_no, p.model_version, p.predicted_rank,
    e.finish_position AS actual_finish,
    e.popularity AS actual_popularity
FROM predictions p
JOIN races r ON r.id = p.race_id
JOIN entries e ON e.race_id = p.race_id AND e.horse_no = p.horse_no;
