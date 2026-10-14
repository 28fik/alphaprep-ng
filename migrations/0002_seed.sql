-- Seed reference data. No administrator is seeded: the first admin is created
-- through the one-time bootstrap endpoint (see README).

INSERT INTO subjects (id, name, category, sort_order) VALUES
  ('english',             'Use of English',                     'compulsory', 0),
  ('mathematics',         'Mathematics',                        'science',    1),
  ('physics',             'Physics',                            'science',    2),
  ('chemistry',           'Chemistry',                          'science',    3),
  ('biology',             'Biology',                            'science',    4),
  ('financial_accounting','Financial Accounting',               'commercial', 5),
  ('commerce',            'Commerce',                           'commercial', 6),
  ('economics',           'Economics',                          'commercial', 7),
  ('literature',          'Literature in English',              'arts',       8),
  ('government',          'Government',                         'arts',       9),
  ('crk',                 'Christian Religious Knowledge (CRK)','arts',      10),
  ('irk',                 'Islamic Religious Knowledge (IRK)',  'arts',      11);

INSERT INTO roles (id, description) VALUES
  ('super_admin',    'Full access including admin management and settings'),
  ('exam_manager',   'Create, publish and manage examinations and results'),
  ('content_editor', 'Manage the question bank and imports'),
  ('viewer',         'Read-only access to dashboards and reports');

INSERT INTO permissions (id, description) VALUES
  ('admins.manage',       'Create or disable administrator accounts'),
  ('settings.write',      'Edit platform settings, announcements, logo'),
  ('questions.read',      'View the question bank (includes answer keys)'),
  ('questions.write',     'Create, edit, delete and import questions'),
  ('exams.read',          'View examinations and previews'),
  ('exams.write',         'Create, edit, publish, cancel examinations'),
  ('participants.read',   'Search and view participant records'),
  ('participants.write',  'Suspend participants, adjust results'),
  ('reports.read',        'View and export leaderboards and reports'),
  ('audit.read',          'View audit logs');

INSERT INTO role_permissions (role_id, permission_id)
  SELECT 'super_admin', id FROM permissions;
INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('exam_manager','exams.read'),('exam_manager','exams.write'),('exam_manager','questions.read'),
  ('exam_manager','participants.read'),('exam_manager','participants.write'),('exam_manager','reports.read'),
  ('content_editor','questions.read'),('content_editor','questions.write'),('content_editor','exams.read'),
  ('viewer','exams.read'),('viewer','participants.read'),('viewer','reports.read');

INSERT INTO settings (key, value) VALUES
  ('utme_countdown_date',  '2027-04-15T08:00:00+01:00'),   -- provisional; edit in admin
  ('utme_countdown_label', 'Provisional UTME date'),
  ('social_x',        'https://x.com/alphaprepng'),
  ('social_tiktok',   'https://www.tiktok.com/@alphaprepng'),
  ('social_whatsapp', 'https://whatsapp.com/channel/0029VbBumIr4IBhHwpUsoH3H'),
  ('whatsapp_gate_enabled', '1'),
  ('whatsapp_share_message', 'I am taking the AlphaPrep NG daily UTME mock exam. Join me and compete on the leaderboard:'),
  ('subject_change_cutoff_hours_before_exam', '2'),
  ('late_submit_grace_seconds', '30'),
  ('tab_hidden_policy', 'auto_submit'),
  ('site_url', '');
