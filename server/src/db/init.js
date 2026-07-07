const Database = require('better-sqlite3');
const path = require('path');

// Файл базы данных появится рядом с этим файлом при первом запуске
const db = new Database(path.join(__dirname, '..', '..', 'quiz.db'));

// Включаем поддержку внешних ключей (по умолчанию в SQLite она выключена)
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('organizer', 'participant')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT,
    time_per_question INTEGER NOT NULL DEFAULT 20, -- секунды
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'ready')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    image_url TEXT,
    type TEXT NOT NULL CHECK(type IN ('single', 'multiple')),
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0 -- 0/1
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'lobby' CHECK(status IN ('lobby', 'running', 'finished')),
    current_question_index INTEGER NOT NULL DEFAULT -1,
    question_started_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS room_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score INTEGER NOT NULL DEFAULT 0,
    UNIQUE(room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_participant_id INTEGER NOT NULL REFERENCES room_participants(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    selected_option_ids TEXT NOT NULL, -- JSON-массив id, например "[1,3]"
    is_correct INTEGER NOT NULL,
    answered_at TEXT DEFAULT (datetime('now'))
  );
`);

const roomColumns = db.prepare('PRAGMA table_info(rooms)').all().map((column) => column.name);
if (!roomColumns.includes('question_started_at')) {
  db.exec('ALTER TABLE rooms ADD COLUMN question_started_at TEXT');
}

module.exports = db;
