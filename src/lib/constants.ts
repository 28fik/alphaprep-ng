export const BRAND = {
  name: "AlphaPrep NG",
  product: "AlphaPrep NG Mock Exam",
  motto: "Prepare. Practice. Perform.",
};

// Official links only. Do not add other platforms unless the owner provides them.
export const SOCIAL_LINKS = [
  { label: "X", href: "https://x.com/alphaprepng" },
  { label: "TikTok", href: "https://www.tiktok.com/@alphaprepng" },
  { label: "WhatsApp Channel", href: "https://whatsapp.com/channel/0029VbBumIr4IBhHwpUsoH3H" },
] as const;

export interface SubjectOption {
  id: string;
  name: string;
  category: "science" | "commercial" | "arts";
}

// Must match the ids seeded in migrations/0002_seed.sql.
// Mathematics appears in Science and Commercial but is ONE subject.
export const SUBJECT_GROUPS: { title: string; subjects: { id: string; name: string }[] }[] = [
  {
    title: "Science",
    subjects: [
      { id: "mathematics", name: "Mathematics" },
      { id: "physics", name: "Physics" },
      { id: "chemistry", name: "Chemistry" },
      { id: "biology", name: "Biology" },
    ],
  },
  {
    title: "Commercial",
    subjects: [
      { id: "mathematics", name: "Mathematics" },
      { id: "financial_accounting", name: "Financial Accounting" },
      { id: "commerce", name: "Commerce" },
      { id: "economics", name: "Economics" },
    ],
  },
  {
    title: "Arts",
    subjects: [
      { id: "literature", name: "Literature in English" },
      { id: "government", name: "Government" },
      { id: "crk", name: "Christian Religious Knowledge (CRK)" },
      { id: "irk", name: "Islamic Religious Knowledge (IRK)" },
    ],
  },
];

export const PARTICIPANT_ID_PATTERN = /^JAMB\d{4}[A-Z]{2}$/;
export const EXAM_RULES = { questions: 180, minutes: 120, maxScore: 400 };
