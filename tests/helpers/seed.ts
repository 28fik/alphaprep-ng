import type { createTestDb } from "./d1.ts";
import { fingerprint } from "../../server/questions.ts";

type TDb = ReturnType<typeof createTestDb>;

export function seedAdmin(db: TDb, username = "editor", role = "super_admin"): number {
  db.raw.prepare("INSERT INTO admins (username, display_name, password_hash, role_id) VALUES (?,?,?,?)").run(username, username, "x", role);
  return Number((db.raw.prepare("SELECT id FROM admins WHERE username = ?").get(username) as any).id);
}

/** Directly insert `n` usable questions (with answer keys) per subject, spread over 4 topics. Answer cycles A-D. */
export async function seedBank(db: TDb, subjects: string[], n: number, opts: { status?: string } = {}) {
  for (const s of subjects) {
    for (let i = 0; i < n; i++) {
      const q = {
        question_text: `${s} question ${i}: what is ${i} plus ${i + 1}?`,
        option_a: `${s}-${i}-alpha`, option_b: `${s}-${i}-beta`, option_c: `${s}-${i}-gamma`, option_d: `${s}-${i}-delta`,
      };
      const fp = await fingerprint(q);
      db.raw
        .prepare(`INSERT INTO questions (subject_id, topic, question_text, option_a, option_b, option_c, option_d, verification_status, fingerprint)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(s, `topic${i % 4}`, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, opts.status ?? "unverified", fp);
      const id = Number((db.raw.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
      db.raw.prepare("INSERT INTO question_answer_keys (question_id, correct_option, answer_source) VALUES (?,?,'manual_admin')").run(id, "ABCD"[i % 4]);
    }
  }
}
