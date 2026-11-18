-- LORE-AI database schema.
-- Applied automatically by the `db` service in docker-compose.yml on first boot
-- (mounted into /docker-entrypoint-initdb.d). Manual apply:
--   mysql -h 127.0.0.1 -u lore -p lore_ai_db < schema.sql

CREATE DATABASE IF NOT EXISTS lore_ai_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE lore_ai_db;

-- ── Perfume catalogue ────────────────────────────────────────────────
-- Read by GET /api/admin/perfumes and by the chat prompt builder
-- (src/types.ts getPerfumeDatabase). Columns mirror the Perfume interface.
CREATE TABLE IF NOT EXISTS perfumes (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand         VARCHAR(120) NOT NULL,
  name          VARCHAR(160) NOT NULL,
  image_url     TEXT NULL,
  scent_family  VARCHAR(120) NULL,
  best_occasion VARCHAR(120) NULL,
  mood          VARCHAR(120) NULL,
  top_notes     TEXT NULL,
  middle_notes  TEXT NULL,
  base_notes    TEXT NULL,
  longevity     VARCHAR(80) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_perfumes_brand (brand),
  KEY idx_perfumes_family (scent_family)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Chat sessions ────────────────────────────────────────────────────
-- One row per conversation; `updated_at` is bumped on every new message.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title      VARCHAR(255) NOT NULL DEFAULT 'New Conversation',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_chat_sessions_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Chat messages ────────────────────────────────────────────────────
-- role is VARCHAR, not ENUM: the client posts arbitrary role strings and a
-- rejected value would abort the whole insert loop in src/routes/chat.ts.
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id INT UNSIGNED NOT NULL,
  role       VARCHAR(16) NOT NULL DEFAULT 'user',
  content    MEDIUMTEXT NOT NULL,
  image_url  TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_chat_messages_session (session_id, created_at),
  CONSTRAINT fk_chat_messages_session
    FOREIGN KEY (session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seed data ────────────────────────────────────────────────────────
-- The 50-perfume catalogue lives in seed.sql, loaded right after this file
-- by docker-compose.yml (02-seed.sql). Nothing is seeded here.
