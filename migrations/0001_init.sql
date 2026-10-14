-- AlphaPrep NG Mock Exam: initial schema (Cloudflare D1 / SQLite)
-- All timestamps are stored as UTC ISO-8601 text (e.g. 2026-10-14T09:00:00Z).
-- Exam DATES (exam_date) are Africa/Lagos calendar dates stored as 'YYYY-MM-DD'.
-- Answer keys live in separate tables so that "SELECT * FROM questions" can
-- never leak them. Public API code must never read the *_answer_keys tables.

-- ---------------------------------------------------------------------------
-- Subjects
-- ---------------------------------------------------------------------------
CREATE TABLE subjects (
  id           TEXT PRIMARY KEY,                 -- e.g. 'english', 'physics'
  name         TEXT NOT NULL UNIQUE,
  category     TEXT NOT NULL CHECK (category IN ('compulsory','science','commercial','arts','other')),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Participants (no email / password; ID-based, see README for trade-offs)
-- ---------------------------------------------------------------------------
CREATE TABLE participants (
  id                 TEXT PRIMARY KEY
                     CHECK (length(id) = 10 AND id GLOB 'JAMB[0-9][0-9][0-9][0-9][A-Z][A-Z]'),
  first_name         TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 60),
  last_name          TEXT NOT NULL CHECK (length(last_name)  BETWEEN 1 AND 60),
  target_score       INTEGER NOT NULL CHECK (target_score BETWEEN 100 AND 400),
  intended_course    TEXT NOT NULL CHECK (length(intended_course) BETWEEN 1 AND 120),
  preferred_institution TEXT NOT NULL CHECK (length(preferred_institution) BETWEEN 1 AND 120),
  gender             TEXT NOT NULL CHECK (gender IN ('male','female')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  suspended_reason   TEXT,
  -- Hash of a random token given to the registering device (httpOnly cookie).
  -- Lets us protect profile edits/exam starts better than the bare ID alone.
  device_token_hash  TEXT,
  -- Hash of identity fingerprint (name + course + institution) used only to
  -- warn about likely duplicate registrations; never shown publicly.
  dedupe_hash        TEXT,
  created_ip_hash    TEXT,
  subjects_locked_at TEXT,                       -- set once participant enters their first exam
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_participants_dedupe ON participants(dedupe_hash);
CREATE INDEX idx_participants_name   ON participants(last_name, first_name);

-- Current subject combination: exactly 3 non-English subjects (enforced in API;
-- English is always implied). History is preserved in attempt_subjects.
CREATE TABLE participant_subjects (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  subject_id     TEXT NOT NULL REFERENCES subjects(id),
  PRIMARY KEY (participant_id, subject_id)
);

-- ---------------------------------------------------------------------------
-- Admin accounts, roles, permissions, sessions
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,                  -- 'super_admin','exam_manager','content_editor','viewer'
  description TEXT NOT NULL
);
CREATE TABLE permissions (
  id          TEXT PRIMARY KEY,                  -- e.g. 'questions.write'
  description TEXT NOT NULL
);
CREATE TABLE role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE admins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 3 AND 40),
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,                  -- PBKDF2-SHA256 (Web Crypto), encoded with params
  role_id        TEXT NOT NULL REFERENCES roles(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE admin_sessions (
  id_hash         TEXT PRIMARY KEY,              -- SHA-256 of the session cookie value
  admin_id        INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token_hash TEXT NOT NULL,
  ip_hash         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at      TEXT NOT NULL
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX idx_admin_sessions_exp   ON admin_sessions(expires_at);

-- Generic fixed-window rate limiter (login, ID lookups, registration, etc.)
CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,                    -- e.g. 'login:<iphash>', 'lookup:<iphash>'
  window_start INTEGER NOT NULL,                 -- unix seconds, floored to window size
  hits         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- ---------------------------------------------------------------------------
-- Question bank
-- ---------------------------------------------------------------------------
CREATE TABLE questions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id          TEXT NOT NULL REFERENCES subjects(id),
  topic               TEXT,
  exam_year           INTEGER CHECK (exam_year IS NULL OR exam_year BETWEEN 1978 AND 2100),
  question_text       TEXT NOT NULL CHECK (length(question_text) > 0),
  option_a            TEXT NOT NULL,
  option_b            TEXT NOT NULL,
  option_c            TEXT NOT NULL,
  option_d            TEXT NOT NULL,
  explanation         TEXT,
  source              TEXT,
  -- 'verified'    : answer key confirmed from a trustworthy source
  -- 'unverified'  : answer present but not confirmed
  -- 'needs_review': uncertain OCR/extraction or missing answer
  verification_status TEXT NOT NULL DEFAULT 'needs_review'
                      CHECK (verification_status IN ('verified','unverified','needs_review')),
  fingerprint         TEXT NOT NULL,             -- hash of normalised question + options
  repeated_evidence   TEXT,                      -- only set when evidence supports "repeated across years"
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by          INTEGER REFERENCES admins(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (subject_id, fingerprint)
);
CREATE INDEX idx_questions_subject_topic ON questions(subject_id, topic);
CREATE INDEX idx_questions_subject_year  ON questions(subject_id, exam_year);
CREATE INDEX idx_questions_status        ON questions(verification_status, is_active);

-- Answer keys are isolated. A question with no row here has no known answer
-- and can never be used in an exam.
CREATE TABLE question_answer_keys (
  question_id    INTEGER PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  correct_option TEXT NOT NULL CHECK (correct_option IN ('A','B','C','D')),
  answer_source  TEXT NOT NULL CHECK (answer_source IN ('official','manual_admin','import_file','ai_suggested')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Bulk import staging
CREATE TABLE import_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id      INTEGER NOT NULL REFERENCES admins(id),
  file_name     TEXT,
  file_type     TEXT NOT NULL CHECK (file_type IN ('csv','xlsx','paste','pdf_text','pdf_ocr')),
  status        TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','committed','discarded')),
  total_rows    INTEGER NOT NULL DEFAULT 0,
  saved_rows    INTEGER NOT NULL DEFAULT 0,
  skipped_rows  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  committed_at  TEXT
);
CREATE TABLE import_rows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number    INTEGER NOT NULL,
  payload_json  TEXT NOT NULL,                   -- parsed question fields (editable in preview)
  issues_json   TEXT NOT NULL DEFAULT '[]',      -- missing answer, malformed, duplicate, low OCR confidence...
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','saved')),
  UNIQUE (batch_id, row_number)
);

-- ---------------------------------------------------------------------------
-- Examinations (frozen snapshot of questions + keys once published)
-- ---------------------------------------------------------------------------
CREATE TABLE exams (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_date            TEXT NOT NULL UNIQUE CHECK (exam_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  title                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','approved','published','locked','cancelled')),
  registration_opens_at TEXT,
  starts_at            TEXT NOT NULL,            -- UTC; window in which participants may begin
  ends_at              TEXT NOT NULL,            -- UTC; no new attempts / hard submission cutoff
  duration_minutes     INTEGER NOT NULL DEFAULT 120 CHECK (duration_minutes BETWEEN 1 AND 300),
  correction_release_at TEXT NOT NULL,           -- UTC; answers/explanations visible after this
  share_gate_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (share_gate_enabled IN (0,1)),
  shuffle_questions    INTEGER NOT NULL DEFAULT 1 CHECK (shuffle_questions IN (0,1)),
  shuffle_options      INTEGER NOT NULL DEFAULT 1 CHECK (shuffle_options IN (0,1)),
  frozen_at            TEXT,                     -- set at publish; questions/keys immutable afterwards
  created_by           INTEGER REFERENCES admins(id),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (ends_at > starts_at),
  CHECK (correction_release_at >= ends_at)
);

CREATE TABLE exam_subjects (
  exam_id        INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  subject_id     TEXT NOT NULL REFERENCES subjects(id),
  question_count INTEGER NOT NULL CHECK (question_count > 0),   -- 60 for English, 40 otherwise
  PRIMARY KEY (exam_id, subject_id)
);

-- Snapshot of each question as it appears in the exam (text + options already
-- shuffled and relabelled A-D). Later bank edits cannot change this table.
CREATE TABLE exam_questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  subject_id    TEXT NOT NULL REFERENCES subjects(id),
  position      INTEGER NOT NULL CHECK (position >= 1),       -- order within the subject section
  question_id   INTEGER REFERENCES questions(id) ON DELETE SET NULL,  -- provenance only
  question_text TEXT NOT NULL,
  option_a      TEXT NOT NULL,
  option_b      TEXT NOT NULL,
  option_c      TEXT NOT NULL,
  option_d      TEXT NOT NULL,
  explanation   TEXT,
  UNIQUE (exam_id, subject_id, position)
);
CREATE INDEX idx_exam_questions_exam ON exam_questions(exam_id, subject_id);
-- No duplicate source question inside one exam
CREATE UNIQUE INDEX idx_exam_questions_unique_src ON exam_questions(exam_id, question_id)
  WHERE question_id IS NOT NULL;

CREATE TABLE exam_answer_keys (
  exam_question_id INTEGER PRIMARY KEY REFERENCES exam_questions(id) ON DELETE CASCADE,
  correct_option   TEXT NOT NULL CHECK (correct_option IN ('A','B','C','D'))
);

-- ---------------------------------------------------------------------------
-- Attempts, answers, results
-- ---------------------------------------------------------------------------
CREATE TABLE attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id          INTEGER NOT NULL REFERENCES exams(id),
  participant_id   TEXT NOT NULL REFERENCES participants(id),
  exam_date        TEXT NOT NULL,                 -- copied from exams.exam_date (Lagos date)
  share_confirmed_at TEXT,                        -- participant clicked "I have shared" (unverifiable)
  started_at       TEXT NOT NULL,                 -- server time
  deadline_at      TEXT NOT NULL,                 -- min(started_at + duration, exams.ends_at + grace) server-computed
  submitted_at     TEXT,                          -- server time of acceptance
  status           TEXT NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress','submitted','auto_submitted','void')),
  submit_reason    TEXT CHECK (submit_reason IS NULL OR submit_reason IN
                   ('manual','timeout','tab_hidden','server_sweep','admin')),
  attempt_token_hash TEXT NOT NULL,               -- binds the attempt to the starting device
  -- Autosaved answers as ONE JSON blob {"<exam_question_id>":"A",...}. One row write per save
  -- (D1 free tier allows ~100k row writes/day, so 180 per-answer rows per participant would
  -- cap us at roughly 550 participants/day).
  answers_json     TEXT NOT NULL DEFAULT '{}',
  answers_saved_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (participant_id, exam_date),             -- one official attempt per participant per day
  UNIQUE (participant_id, exam_id)
);
CREATE INDEX idx_attempts_exam_status ON attempts(exam_id, status);

-- Subject combination used for THIS attempt (history preserved forever)
CREATE TABLE attempt_subjects (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  PRIMARY KEY (attempt_id, subject_id)
);

-- Official results: written only by the server at submission time
CREATE TABLE results (
  attempt_id      INTEGER PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  exam_id         INTEGER NOT NULL REFERENCES exams(id),
  participant_id  TEXT NOT NULL REFERENCES participants(id),
  exam_date       TEXT NOT NULL,
  total_score     REAL NOT NULL CHECK (total_score BETWEEN 0 AND 400),
  max_score       INTEGER NOT NULL DEFAULT 400,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
  submitted_at    TEXT NOT NULL,
  is_eligible     INTEGER NOT NULL DEFAULT 1 CHECK (is_eligible IN (0,1)),  -- 0 = hidden from leaderboards
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (participant_id, exam_id)
);
CREATE INDEX idx_results_daily  ON results(exam_date, is_eligible, total_score DESC, duration_seconds, submitted_at);
CREATE INDEX idx_results_person ON results(participant_id, exam_date);

CREATE TABLE result_subject_scores (
  attempt_id    INTEGER NOT NULL REFERENCES results(attempt_id) ON DELETE CASCADE,
  subject_id    TEXT NOT NULL REFERENCES subjects(id),
  correct_count INTEGER NOT NULL CHECK (correct_count >= 0),
  question_count INTEGER NOT NULL CHECK (question_count > 0),
  score         REAL NOT NULL CHECK (score BETWEEN 0 AND 100),   -- correct / question_count * 100
  PRIMARY KEY (attempt_id, subject_id)
);

-- Authorised administrative corrections (never silently edit results)
CREATE TABLE result_adjustments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id   INTEGER NOT NULL REFERENCES results(attempt_id),
  admin_id     INTEGER NOT NULL REFERENCES admins(id),
  old_total    REAL NOT NULL,
  new_total    REAL NOT NULL,
  reason       TEXT NOT NULL CHECK (length(reason) >= 5),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------------------------
-- Leaderboards: reproducible views (no stored copies to drift out of sync)
-- Ranking policy: higher total first; equal totals SHARE the same rank
-- (RANK semantics). Display order for ties: shorter duration, then earlier
-- submission, then participant id. Only is_eligible = 1 results are ranked.
-- ---------------------------------------------------------------------------
CREATE VIEW v_daily_leaderboard AS
SELECT
  r.exam_date,
  r.participant_id,
  p.first_name || ' ' || substr(p.last_name, 1, 1) || '.' AS display_name,
  r.total_score,
  r.duration_seconds,
  r.submitted_at,
  RANK() OVER (PARTITION BY r.exam_date ORDER BY r.total_score DESC) AS rank
FROM results r
JOIN participants p ON p.id = r.participant_id
WHERE r.is_eligible = 1 AND p.status = 'active';

-- Weeks run Monday to Sunday in Africa/Lagos. exam_date is already a Lagos date,
-- so week_start is a pure date calculation (no device clock involved).
-- Missed days contribute nothing to SUM, i.e. zero. Max = 7 x 400 = 2800.
CREATE VIEW v_weekly_totals AS
SELECT
  date(r.exam_date, '-' || ((CAST(strftime('%w', r.exam_date) AS INTEGER) + 6) % 7) || ' days') AS week_start,
  r.participant_id,
  SUM(r.total_score)  AS weekly_total,
  COUNT(*)            AS exams_taken,
  ROUND(SUM(r.total_score) / 2800.0 * 100.0, 2) AS weekly_percentage,
  SUM(r.duration_seconds) AS total_duration
FROM results r
JOIN participants p ON p.id = r.participant_id
WHERE r.is_eligible = 1 AND p.status = 'active'
GROUP BY week_start, r.participant_id;

-- ---------------------------------------------------------------------------
-- Announcements, settings, assets, audit log
-- ---------------------------------------------------------------------------
CREATE TABLE announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0,1)),
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  created_by  INTEGER REFERENCES admins(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  INTEGER REFERENCES admins(id),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE assets (                              -- e.g. the official logo (small files only)
  key          TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data         BLOB NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id     INTEGER REFERENCES admins(id),
  action       TEXT NOT NULL,                     -- e.g. 'exam.publish', 'result.adjust'
  target_type  TEXT,
  target_id    TEXT,
  details_json TEXT,
  ip_hash      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_admin   ON audit_logs(admin_id, created_at);
