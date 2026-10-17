import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Countdown from "../components/Countdown";
import ParticipantIdForm from "../components/ParticipantIdForm";
import StateBox from "../components/StateBox";
import { api, type LeaderboardRow, type PublicStatus } from "../lib/api";
import { BRAND, EXAM_RULES, SOCIAL_LINKS } from "../lib/constants";

const PHASE_TEXT: Record<PublicStatus["phase"], { label: string; tone: string }> = {
  none: { label: "No examination scheduled yet", tone: "bg-slate-600" },
  registration_open: { label: "Registration is open", tone: "bg-emerald-500" },
  ongoing: { label: "Examination is ongoing", tone: "bg-brand-blue" },
  closed: { label: "Examination has closed", tone: "bg-rose-500" },
};

const STEPS = [
  ["Get your ID", "Register once to receive a Participant ID. No email or password needed."],
  ["Enter your ID", "Use it each day to open that day's mock exam."],
  ["Write 180 questions", `${EXAM_RULES.minutes} minutes: 60 Use of English plus 40 each in your three subjects.`],
  ["See your score", `Scored by the server out of ${EXAM_RULES.maxScore}. Corrections are released later by the admin.`],
  ["Climb the board", "Daily rankings, plus weekly totals out of 2,800."],
];

function Leaderboard({ title, rows, loading }: { title: string; rows: LeaderboardRow[] | null; loading: boolean }) {
  return (
    <section aria-labelledby={`lb-${title}`} className="rounded-2xl border border-white/15 bg-brand-navy-2 p-4">
      <h3 id={`lb-${title}`} className="text-lg font-semibold">{title}</h3>
      <div className="mt-3">
        {loading ? (
          <StateBox kind="loading">Loading rankings…</StateBox>
        ) : !rows || rows.length === 0 ? (
          <StateBox kind="empty">No results yet. Rankings appear after the first submissions.</StateBox>
        ) : (
          <ol className="divide-y divide-white/10">
            {rows.map((r) => (
              <li key={`${r.rank}-${r.display_name}`} className="flex items-center justify-between py-2 text-sm">
                <span><span className="mr-3 inline-block w-6 font-bold text-brand-blue">{r.rank}</span>{r.display_name}</span>
                <span className="font-semibold tabular-nums">{r.total_score ?? r.weekly_total}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function socials(status: PublicStatus | null) {
  const s = status?.settings;
  return [
    { label: "X", href: s?.social_x || SOCIAL_LINKS[0].href },
    { label: "TikTok", href: s?.social_tiktok || SOCIAL_LINKS[1].href },
    { label: "WhatsApp Channel", href: s?.social_whatsapp || SOCIAL_LINKS[2].href },
  ];
}

export default function Home() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [daily, setDaily] = useState<LeaderboardRow[] | null>(null);
  const [weekly, setWeekly] = useState<LeaderboardRow[] | null>(null);
  const [lbLoading, setLbLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ rows: LeaderboardRow[] }>("/leaderboard/daily?limit=5").then((r) => alive && setDaily(r.rows)),
      api<{ rows: LeaderboardRow[] }>("/leaderboard/weekly?limit=5").then((r) => alive && setWeekly(r.rows)),
    ]).catch(() => undefined).finally(() => alive && setLbLoading(false));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    api<PublicStatus>("/status")
      .then((s) => alive && setStatus(s))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const phase = status ? PHASE_TEXT[status.phase] : null;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16">
      {/* Hero */}
      <section className="py-10 md:py-16">
        <p className="text-sm font-semibold uppercase tracking-widest text-brand-blue">{BRAND.motto}</p>
        <h1 className="mt-3 text-3xl font-bold leading-tight md:text-5xl">
          Daily UTME mock exams built to make you compete.
        </h1>
        <p className="mt-4 max-w-2xl text-base text-slate-200 md:text-lg">
          AlphaPrep NG helps UTME candidates prepare through competitive mock examinations. Sit a full 180-question paper,
          get an official server-marked score out of 400, and see where you stand on the daily and weekly leaderboards.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link
            to="/start"
            className="rounded-xl bg-brand-blue px-6 py-4 text-center text-base font-bold tracking-wide text-brand-navy hover:bg-brand-blue-dark"
          >
            START MOCK EXAM
          </Link>
          <a
            href="#how-it-works"
            className="rounded-xl border border-white/30 px-6 py-4 text-center text-base font-semibold hover:bg-brand-navy-2"
          >
            How it works
          </a>
        </div>
      </section>

      {/* Status + countdown */}
      <section aria-label="Examination status" className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-white/15 bg-brand-navy-2 p-5">
          <h2 className="text-lg font-semibold">Examination status</h2>
          <div className="mt-3">
            {loading ? (
              <StateBox kind="loading">Checking today's examination…</StateBox>
            ) : error ? (
              <StateBox kind="error">{error}</StateBox>
            ) : phase ? (
              <>
                <p className="flex items-center gap-2 text-base font-semibold">
                  <span className={`h-3 w-3 rounded-full ${phase.tone}`} aria-hidden="true" />
                  {phase.label}
                </p>
                {status?.exam && (
                  <p className="mt-2 text-sm text-slate-300">{status.exam.title} · {status.exam.exam_date}</p>
                )}
              </>
            ) : null}
          </div>
        </div>
        <div className="rounded-2xl border border-white/15 bg-brand-navy-2 p-5">
          {status?.countdown ? (
            <Countdown target={status.countdown.target} label={status.countdown.label} />
          ) : (
            <>
              <h2 className="text-lg font-semibold">UTME countdown</h2>
              <div className="mt-3"><StateBox kind="empty">The countdown date has not been set yet.</StateBox></div>
            </>
          )}
        </div>
      </section>

      {/* Participant ID */}
      <section className="mt-8 md:max-w-xl" aria-label="Participant ID">
        <ParticipantIdForm />
      </section>

      {/* Announcements */}
      <section className="mt-10" aria-labelledby="ann">
        <h2 id="ann" className="text-xl font-bold">Announcements</h2>
        <div className="mt-3 space-y-3">
          {loading ? (
            <StateBox kind="loading">Loading announcements…</StateBox>
          ) : !status || status.announcements.length === 0 ? (
            <StateBox kind="empty">No announcements right now.</StateBox>
          ) : (
            status.announcements.map((a) => (
              <article key={a.id} className="rounded-xl border border-white/15 bg-brand-navy-2 p-4">
                <h3 className="font-semibold">{a.title}</h3>
                <p className="mt-1 whitespace-pre-line text-sm text-slate-200">{a.body}</p>
              </article>
            ))
          )}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="mt-12 scroll-mt-20" aria-labelledby="how">
        <h2 id="how" className="text-xl font-bold">How the examination works</h2>
        <ol className="mt-4 grid gap-3 md:grid-cols-5">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="rounded-xl border border-white/15 bg-brand-navy-2 p-4">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-blue text-sm font-bold text-brand-navy">{i + 1}</span>
              <h3 className="mt-3 font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-slate-300">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Leaderboards (top 5 each; full lists on /leaderboard) */}
      <section id="leaderboards" className="mt-12 scroll-mt-20" aria-labelledby="lbs">
        <h2 id="lbs" className="text-xl font-bold">Leaderboards</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Leaderboard title="Daily leaderboard" rows={daily} loading={lbLoading} />
          <Leaderboard title="Weekly leaderboard" rows={weekly} loading={lbLoading} />
        </div>
        <Link to="/leaderboard" className="mt-3 inline-block text-sm font-semibold text-brand-blue underline">See full leaderboards</Link>
      </section>

      {/* Social */}
      <section className="mt-12" aria-labelledby="soc">
        <h2 id="soc" className="text-xl font-bold">Follow AlphaPrep NG</h2>
        <ul className="mt-3 flex flex-wrap gap-3">
          {socials(status).map((s) => (
            <li key={s.href}>
              <a href={s.href} target="_blank" rel="noopener noreferrer"
                 className="inline-block rounded-xl border border-brand-blue/60 px-5 py-3 text-sm font-semibold text-brand-blue hover:bg-brand-blue hover:text-brand-navy">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
