import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import Logo from "./Logo";
import { BRAND, SOCIAL_LINKS } from "../lib/constants";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/#how-it-works", label: "How it works", hash: true },
  { to: "/#leaderboards", label: "Leaderboards", hash: true },
  { to: "/start", label: "Start exam" },
];

export default function Layout() {
  const [open, setOpen] = useState(false);
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-3 text-base font-medium md:py-2 ${
      isActive ? "bg-brand-navy-3 text-white" : "text-slate-200 hover:bg-brand-navy-2"
    }`;

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-brand-navy">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-white/10 bg-brand-navy/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" aria-label={`${BRAND.name} home`}>
            <Logo />
          </Link>
          <button
            type="button"
            className="rounded-lg border border-white/20 px-3 py-2 text-sm font-medium md:hidden"
            aria-expanded={open}
            aria-controls="main-nav"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Close" : "Menu"}
          </button>
          <nav
            id="main-nav"
            aria-label="Main"
            className={`${open ? "block" : "hidden"} absolute left-0 right-0 top-full border-b border-white/10 bg-brand-navy p-3 md:static md:block md:border-0 md:bg-transparent md:p-0`}
          >
            <ul className="flex flex-col gap-1 md:flex-row md:items-center">
              {NAV.map((item) => (
                <li key={item.to}>
                  {item.hash ? (
                    <a className="block rounded-lg px-3 py-3 text-base font-medium text-slate-200 hover:bg-brand-navy-2 md:py-2" href={item.to} onClick={() => setOpen(false)}>
                      {item.label}
                    </a>
                  ) : (
                    <NavLink to={item.to} end={item.end} className={linkClass} onClick={() => setOpen(false)}>
                      {item.label}
                    </NavLink>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      <main id="main" className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-white/10 bg-brand-navy-2">
        <div className="mx-auto max-w-5xl px-4 py-8">
          <Logo />
          <p className="mt-2 text-sm text-slate-300">{BRAND.motto}</p>
          <ul className="mt-4 flex flex-wrap gap-3">
            {SOCIAL_LINKS.map((s) => (
              <li key={s.href}>
                <a
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block rounded-lg border border-brand-blue/50 px-4 py-2 text-sm font-medium text-brand-blue hover:bg-brand-blue hover:text-brand-navy"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-xs text-slate-400">
            AlphaPrep NG Mock Exam is an independent practice platform and is not affiliated with JAMB.
          </p>
        </div>
      </footer>
    </div>
  );
}
