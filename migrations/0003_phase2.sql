-- Phase 2: trusted devices and recovery codes for passwordless participants.
-- A Participant ID alone is only an identifier. A device becomes "trusted" for an ID when it
-- registered that ID or proved knowledge of the one-time recovery code shown at registration.

ALTER TABLE participants ADD COLUMN recovery_code_hash TEXT;   -- HMAC(pepper, id + code); never the code itself

CREATE TABLE participant_devices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,            -- SHA-256 of the random cookie value
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_devices_participant ON participant_devices(participant_id);

-- participants.device_token_hash from 0001 is superseded by participant_devices and is unused.

INSERT INTO settings (key, value) VALUES
  ('login_max_failures', '5'),
  ('login_lockout_minutes', '15');
