-- Phase 3/4: once an exam is published (frozen_at set) its questions and answer keys can no longer
-- be inserted, changed or deleted, even by buggy code. Deleting a bank question only nulls
-- exam_questions.question_id (provenance), which is deliberately still allowed.

CREATE TRIGGER trg_exam_questions_frozen_ins
BEFORE INSERT ON exam_questions
WHEN (SELECT frozen_at FROM exams WHERE id = NEW.exam_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'exam is frozen'); END;

CREATE TRIGGER trg_exam_questions_frozen_upd
BEFORE UPDATE OF exam_id, subject_id, position, question_text, option_a, option_b, option_c, option_d, explanation
ON exam_questions
WHEN (SELECT frozen_at FROM exams WHERE id = OLD.exam_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'exam is frozen'); END;

CREATE TRIGGER trg_exam_questions_frozen_del
BEFORE DELETE ON exam_questions
WHEN (SELECT frozen_at FROM exams WHERE id = OLD.exam_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'exam is frozen'); END;

CREATE TRIGGER trg_exam_keys_frozen_ins
BEFORE INSERT ON exam_answer_keys
WHEN (SELECT e.frozen_at FROM exams e JOIN exam_questions q ON q.exam_id = e.id WHERE q.id = NEW.exam_question_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'exam is frozen'); END;

CREATE TRIGGER trg_exam_keys_frozen_upd
BEFORE UPDATE ON exam_answer_keys
WHEN (SELECT e.frozen_at FROM exams e JOIN exam_questions q ON q.exam_id = e.id WHERE q.id = OLD.exam_question_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'exam is frozen'); END;

CREATE TRIGGER trg_exam_keys_frozen_del
BEFORE DELETE ON exam_answer_keys
WHEN (SELECT e.frozen_at FROM exams e JOIN exam_questions q ON q.exam_id = e.id WHERE q.id = OLD.exam_question_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'exam is frozen'); END;

-- A frozen exam's subject list is part of the freeze too.
CREATE TRIGGER trg_exam_subjects_frozen_ins
BEFORE INSERT ON exam_subjects
WHEN (SELECT frozen_at FROM exams WHERE id = NEW.exam_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'exam is frozen'); END;

CREATE TRIGGER trg_exam_subjects_frozen_del
BEFORE DELETE ON exam_subjects
WHEN (SELECT frozen_at FROM exams WHERE id = OLD.exam_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'exam is frozen'); END;

CREATE INDEX idx_attempts_deadline ON attempts(status, deadline_at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('exam_default_duration_minutes', '120'),
  ('recent_exam_avoid_days', '14');

-- Import staging: indexed duplicate key (subject|fingerprint) so duplicate checks do not scan the batch.
ALTER TABLE import_rows ADD COLUMN dedupe_key TEXT;
CREATE INDEX idx_import_rows_key ON import_rows(batch_id, dedupe_key);

CREATE INDEX IF NOT EXISTS idx_exam_questions_qid ON exam_questions(question_id);
