export const PARTICIPANT_ID_RE = /^JAMB\d{4}[A-Z]{2}$/;
export const ENGLISH_ID = "english";

/** Uppercase/trim an ID typed by a user. Returns null if it is not in JAMB1234AB format. */
export function normalizeId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toUpperCase();
  return PARTICIPANT_ID_RE.test(id) ? id : null;
}

/** Recovery codes look like K7M2-9QXP; hyphens/spaces/case are ignored when comparing. */
export function normalizeRecoveryCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z2-9]{8}$/.test(code) ? code : null;
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // strip control characters, collapse whitespace
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;

export interface RegistrationInput {
  first_name: string;
  last_name: string;
  target_score: number;
  intended_course: string;
  preferred_institution: string;
  gender: "male" | "female";
  subjects: string[];
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

/**
 * Validate exactly three DISTINCT non-English subjects from the active subject list.
 * Any mix of Science / Commercial / Arts subjects is allowed. English is added automatically.
 */
export function validateSubjects(raw: unknown, allowed: Set<string>): Validation<string[]> {
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    return { ok: false, errors: { subjects: "Select exactly three subjects." } };
  }
  const subjects = raw as string[];
  if (subjects.includes(ENGLISH_ID)) {
    return { ok: false, errors: { subjects: "Use of English is added automatically. Choose three other subjects." } };
  }
  if (new Set(subjects).size !== subjects.length) {
    return { ok: false, errors: { subjects: "Each subject can only be chosen once." } };
  }
  if (subjects.length !== 3) {
    return { ok: false, errors: { subjects: "Select exactly three subjects (English is added automatically)." } };
  }
  if (subjects.some((s) => !allowed.has(s))) {
    return { ok: false, errors: { subjects: "One or more selected subjects are not available." } };
  }
  return { ok: true, value: [...subjects].sort() };
}

export function validateRegistration(raw: unknown, allowedSubjects: Set<string>): Validation<RegistrationInput> {
  const errors: Record<string, string> = {};
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const first_name = cleanText(r.first_name, 60);
  if (!first_name || !NAME_RE.test(first_name)) errors.first_name = "Enter a valid first name (letters only).";
  const last_name = cleanText(r.last_name, 60);
  if (!last_name || !NAME_RE.test(last_name)) errors.last_name = "Enter a valid last name (letters only).";

  const target = typeof r.target_score === "number" ? r.target_score : Number.NaN;
  if (!Number.isInteger(target) || target < 100 || target > 400) {
    errors.target_score = "Enter a target score between 100 and 400.";
  }

  const intended_course = cleanText(r.intended_course, 120);
  if (!intended_course) errors.intended_course = "Enter your intended course.";
  const preferred_institution = cleanText(r.preferred_institution, 120);
  if (!preferred_institution) errors.preferred_institution = "Enter your preferred institution.";

  if (r.gender !== "male" && r.gender !== "female") errors.gender = "Select a gender.";

  const subj = validateSubjects(r.subjects, allowedSubjects);
  if (!subj.ok) Object.assign(errors, subj.errors);

  if (Object.keys(errors).length || !subj.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      first_name: first_name!,
      last_name: last_name!,
      target_score: target,
      intended_course: intended_course!,
      preferred_institution: preferred_institution!,
      gender: r.gender as "male" | "female",
      subjects: subj.value,
    },
  };
}

/** Admin password policy: at least 12 characters, not equal to the username. */
export function validateAdminPassword(password: unknown, username: string): string | null {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 200) return "Password is too long.";
  if (password.toLowerCase() === username.toLowerCase()) return "Password must not match the username.";
  return null;
}
