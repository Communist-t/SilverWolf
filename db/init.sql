-- ============================================================
-- Silver Wolf Agent — PostgreSQL 初始化脚本
-- 从 SQLite 迁移而来，所有表结构保持业务逻辑一致
-- ============================================================

-- 启用 UUID 扩展（如果后续需要用 UUID 类型）
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. sessions — 对话会话
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL DEFAULT 'local-default',
    title        TEXT NOT NULL DEFAULT '新对话',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
    ON sessions(updated_at);

CREATE INDEX IF NOT EXISTS idx_sessions_owner_id
    ON sessions(owner_id);

-- ============================================================
-- 2. messages — 对话消息
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
    id           SERIAL PRIMARY KEY,
    session_id   TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id_id
    ON messages(session_id, id);

-- ============================================================
-- 3. session_summaries — 会话摘要记忆
-- ============================================================
CREATE TABLE IF NOT EXISTS session_summaries (
    session_id                  TEXT PRIMARY KEY,
    content                     TEXT NOT NULL,
    summarized_through_message_id INTEGER NOT NULL DEFAULT 0,
    updated_at                  TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- ============================================================
-- 4. tool_runs — 工具运行记录
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_runs (
    id            SERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL,
    tool_type     TEXT NOT NULL,
    intent        TEXT NOT NULL,
    query         TEXT NOT NULL,
    queries_json  TEXT NOT NULL,
    provider      TEXT NOT NULL,
    results_json  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'success',
    error         TEXT,
    fetched_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_runs_session_id_id
    ON tool_runs(session_id, id DESC);

-- ============================================================
-- 5. users — 用户
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL DEFAULT '',
    avatar_url    TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'super_admin')),
    created_at    TEXT NOT NULL
);

-- ============================================================
-- 6. user_tokens — 登录令牌
-- ============================================================
CREATE TABLE IF NOT EXISTS user_tokens (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_tokens_user_id
    ON user_tokens(user_id);

-- ============================================================
-- 7. email_verification_codes — 邮箱验证码
-- ============================================================
CREATE TABLE IF NOT EXISTS email_verification_codes (
    email       TEXT NOT NULL,
    code        TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_verification_codes_email
    ON email_verification_codes(email);

-- ============================================================
-- 8. long_term_memories — 长期记忆
-- ============================================================
CREATE TABLE IF NOT EXISTS long_term_memories (
    id                SERIAL PRIMARY KEY,
    owner_id          TEXT NOT NULL,
    memory_key        TEXT NOT NULL,
    category          TEXT NOT NULL,
    content           TEXT NOT NULL,
    keywords_json     TEXT NOT NULL DEFAULT '[]',
    status            TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'forgotten')),
    evidence_count    INTEGER NOT NULL DEFAULT 1,
    confidence        REAL NOT NULL DEFAULT 0.5,
    explicit          INTEGER NOT NULL DEFAULT 0,
    source_session_id TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    last_recalled_at  TEXT,
    UNIQUE(owner_id, memory_key)
);

CREATE INDEX IF NOT EXISTS idx_long_term_memories_owner_status
    ON long_term_memories(owner_id, status, updated_at DESC);

-- ============================================================
-- 9. llm_model_configs — 大模型配置
-- ============================================================
CREATE TABLE IF NOT EXISTS llm_model_configs (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    provider    TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    model       TEXT NOT NULL,
    api_key     TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    built_in    INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- 部分唯一索引：同一时间只能有一个 active=1 的配置
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_model_configs_single_active
    ON llm_model_configs(active)
    WHERE active = 1;

-- ============================================================
-- 10. fitness_profile — 健身档案
-- ============================================================
CREATE TABLE IF NOT EXISTS fitness_profile (
    owner_id        TEXT PRIMARY KEY,
    bmr             INTEGER DEFAULT 0,
    calorie_target  INTEGER DEFAULT 0,
    protein_target_g REAL DEFAULT 0,
    carbs_target_g   REAL DEFAULT 0,
    fat_target_g     REAL DEFAULT 0,
    weight_kg       REAL,
    height_cm       REAL,
    age             INTEGER,
    gender          TEXT,
    activity_level  TEXT DEFAULT 'sedentary',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- ============================================================
-- 11. fitness_daily — 每日健身记录
-- ============================================================
CREATE TABLE IF NOT EXISTS fitness_daily (
    id          SERIAL PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    date        TEXT NOT NULL,
    calories    INTEGER DEFAULT 0,
    protein_g   REAL DEFAULT 0,
    carbs_g     REAL DEFAULT 0,
    fat_g       REAL DEFAULT 0,
    water_ml    INTEGER DEFAULT 0,
    sleep_hours REAL DEFAULT 0,
    notes       TEXT DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(owner_id, date)
);

CREATE INDEX IF NOT EXISTS idx_fitness_daily_owner_date
    ON fitness_daily(owner_id, date DESC);

-- ============================================================
-- 12. fitness_workouts — 训练记录
-- ============================================================
CREATE TABLE IF NOT EXISTS fitness_workouts (
    id               SERIAL PRIMARY KEY,
    owner_id         TEXT NOT NULL,
    date             TEXT NOT NULL,
    type             TEXT NOT NULL CHECK (type IN ('cardio', 'strength', 'mixed')),
    duration_minutes INTEGER NOT NULL,
    details          TEXT DEFAULT '',
    intensity        TEXT DEFAULT 'moderate' CHECK (intensity IN ('low', 'moderate', 'high')),
    created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fitness_workouts_owner_date
    ON fitness_workouts(owner_id, date DESC);

-- ============================================================
-- 13. fitness_meals — 饮食记录
-- ============================================================
CREATE TABLE IF NOT EXISTS fitness_meals (
    id          SERIAL PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    date        TEXT NOT NULL,
    meal_type   TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    food_name   TEXT NOT NULL,
    calories    INTEGER NOT NULL,
    protein_g   REAL DEFAULT 0,
    carbs_g     REAL DEFAULT 0,
    fat_g       REAL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fitness_meals_owner_date
    ON fitness_meals(owner_id, date DESC);
