"use client";
import { monthlyEstimate, PLANS, type PlanId } from "@routenorth/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { LogoMark } from "@/components/Logo";
import { useI18n } from "@/lib/i18n-context";
import { COPY, type Copy } from "./copy";
import "./landing.css";

/** The north arrow: the same shape as the vehicle marker on the live map. It is the one motif of this page. */
const NORTH = "50,0 100,100 50,70 0,100";
const money = (n: number, locale: string) => new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(n);

function Nav({ c }: { c: Copy }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="lp-nav">
      <Link href="/" className="lp-brand" aria-label="RouteNorth"><LogoMark size={30} /><span>RouteNorth</span></Link>
      <nav className={open ? "open" : ""} aria-label="Main">
        <a href="#features" onClick={() => setOpen(false)}>{c.nav.features}</a>
        <a href="#pricing" onClick={() => setOpen(false)}>{c.nav.pricing}</a>
        <a href="#faq" onClick={() => setOpen(false)}>{c.nav.faq}</a>
        <Link href="/login">{c.nav.signIn}</Link>
        <LanguageToggle />
      </nav>
      <Link href="/signup" className="lp-btn lp-btn-sm">{c.nav.start}</Link>
      <button type="button" className="lp-menu" aria-expanded={open} aria-label={c.nav.menu} onClick={() => setOpen(!open)}><span /><span /><span /></button>
    </header>
  );
}

function Hero({ c }: { c: Copy }) {
  const rows = [
    { n: "Truck 7", s: "moving", v: "38" }, { n: "Bus 3", s: "moving", v: "34" }, { n: "Truck 12", s: "idle", v: "0" },
  ];
  return (
    <section className="lp-hero">
      <svg className="lp-north" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><polygon points={NORTH} /></svg>
      <div className="lp-hero-copy">
        <h1><span>{c.hero.h1a}</span> <span>{c.hero.h1b}</span></h1>
        <p>{c.hero.sub}</p>
        <div className="lp-actions">
          <Link href="/signup" className="lp-btn">{c.hero.cta}</Link>
          <a href="#showcase" className="lp-link">{c.hero.second}</a>
        </div>
      </div>
      <figure className="lp-ui lp-hero-ui" data-ui>
        <figcaption>{c.hero.demo}</figcaption>
        <div className="lp-ui-head"><strong>{c.hero.fleet}</strong><span className="lp-live">Live</span></div>
        <ul>
          {rows.map((r) => (
            <li key={r.n}>
              <span className={`dot ${r.s}`} aria-hidden="true" />
              <span className="n">{r.n}</span>
              <span className="st">{r.s === "moving" ? c.hero.moving : c.hero.idle}</span>
              <span className="v">{r.v} {c.hero.kmh}</span>
            </li>
          ))}
        </ul>
      </figure>
    </section>
  );
}

/** One small real piece of the product per tile, cropped by the tile. These are drawings of the app with demo numbers. */
function Features({ c }: { c: Copy }) {
  const t = c.features.tiles;
  const tone = ["navy", "amber", "blue", "pale", "navy", "amber", "blue"] as const;
  const size = ["a", "b", "c", "d", "e", "f", "g"] as const;
  return (
    <section className="lp-features" id="features" aria-labelledby="features-h">
      <div className="board">
        <div className="tile head"><h2 id="features-h">{c.features.title}</h2></div>
        {t.map((x, i) => (
          <div key={x.name} className={`tile ${size[i]} ${tone[i]}`}>
            {i === 0 && (
              <svg className="art" viewBox="0 0 600 400" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
                <g fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"><path d="M-20 300 H620" /><path d="M120 -20 V420" /><path d="M430 -20 V420" /><path d="M-20 420 L620 120" strokeWidth="5" /></g>
                <path d="M40 330 C 150 330, 190 230, 290 230 S 450 270, 560 150" fill="none" stroke="#f2a900" strokeWidth="4" strokeDasharray="2 12" strokeLinecap="round" />
                <g fill="#f2a900"><polygon points="560,128 572,162 560,155 548,162" transform="rotate(35 560 150)" /><polygon points="290,206 302,240 290,233 278,240" transform="rotate(80 290 230)" /></g>
              </svg>
            )}
            <span className="fig" aria-hidden="true">{x.fig}</span>
            <div className="cap"><h3>{x.name}</h3><p>{x.line}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MapArt({ c }: { c: Copy }) {
  return (
    <svg viewBox="0 0 360 260" role="img" aria-label={c.showcase.items[0]!.name} className="art">
      <rect width="360" height="260" fill="#eef2f6" />
      <g stroke="#d7dee6" strokeWidth="10" fill="none" strokeLinecap="round"><path d="M0 70 H360" /><path d="M0 170 H360" /><path d="M90 0 V260" /><path d="M250 0 V260" /><path d="M0 230 L360 20" strokeWidth="6" /></g>
      <path d="M30 200 C 100 200, 110 120, 170 120 S 260 150, 320 60" fill="none" stroke="#0f5fa8" strokeWidth="3" strokeDasharray="1 6" strokeLinecap="round" />
      {[{ x: 320, y: 60, r: 28, l: "Truck 7 · 38 km/h" }, { x: 170, y: 120, r: -20, l: "Bus 3 · 34 km/h" }].map((v) => (
        <g key={v.l} transform={`translate(${v.x} ${v.y}) rotate(${v.r})`}>
          <circle r="16" fill="#16a05a" opacity=".2" /><polygon points="0,-11 8,9 0,5 -8,9" fill="#16a05a" stroke="#fff" strokeWidth="2" />
        </g>
      ))}
      <g fontFamily="Inter, sans-serif" fontSize="12" fontWeight="600" fill="#0a2540">
        <text x="226" y="46">Truck 7 · 38 km/h</text><text x="120" y="152">Bus 3 · 34 km/h</text>
      </g>
      <g transform="translate(40 206)"><circle r="7" fill="#e0a000" /><text x="14" y="4" fontFamily="Inter, sans-serif" fontSize="12" fontWeight="600" fill="#0a2540">Truck 12 · idle</text></g>
    </svg>
  );
}
function IdleArt() {
  const bars = [["Truck 7", 100, "7 h 30"], ["Truck 12", 39, "2 h 56"], ["Bus 3", 18, "1 h 22"]] as const;
  return (
    <div className="art idle" role="img" aria-label="Idle time by vehicle">
      <p className="big">11 h 48 min <small>idle, last 7 days</small></p>
      {bars.map(([n, w, v]) => (<div key={n} className="row"><span>{n}</span><i><b style={{ width: `${w}%` }} /></i><em>{v}</em></div>))}
      <p className="sub">43.7 L · $74.37 · 117 kg CO₂</p>
    </div>
  );
}
function HosArt() {
  const m = [["Driving", 2.2, 13, "2.2 / 13 h"], ["On-duty window", 6.9, 14, "6.9 / 14 h"], ["Cycle", 15, 70, "15 / 70 h"]] as const;
  return (
    <div className="art hos" role="img" aria-label="Hours of service">
      <p className="big">3 h 12 min <small>left to drive</small></p>
      {m.map(([n, u, l, d]) => (<div key={n} className="meter"><div><span>{n}</span><em>{d}</em></div><i><b style={{ width: `${(u / l) * 100}%` }} /></i></div>))}
    </div>
  );
}
function PhoneArt() {
  return (
    <div className="art phone" role="img" aria-label="Driver app">
      <div className="stop"><span className="num">1</span><div><strong>Queen &amp; Yonge</strong><small>1 Queen St W · 3 pkg</small></div></div>
      <div className="b">I’ve arrived</div><div className="b main">Complete delivery</div><div className="b">Can’t deliver</div>
    </div>
  );
}

function Showcase({ c }: { c: Copy }) {
  const [i, setI] = useState(0);
  const art = [<MapArt key="m" c={c} />, <IdleArt key="i" />, <HosArt key="h" />, <PhoneArt key="p" />][i]!;
  return (
    <section className="lp-showcase" id="showcase" aria-labelledby="showcase-h" data-pick={i}>
      <div className="list">
        <h2 id="showcase-h">{c.showcase.title}</h2>
        <div role="tablist" aria-label={c.showcase.title}>
          {c.showcase.items.map((x, k) => (
            <button key={x.name} role="tab" type="button" aria-selected={i === k} aria-controls="showcase-panel" id={`sc-${k}`} onClick={() => setI(k)}>{x.name}</button>
          ))}
        </div>
      </div>
      <div className="stage" id="showcase-panel" role="tabpanel" aria-labelledby={`sc-${i}`}>
        <div className="disc" aria-hidden="true" />
        <figure className="lp-ui obj" data-ui key={i}>{art}<figcaption>{c.showcase.demo}</figcaption></figure>
        <p className="fact">{c.showcase.items[i]!.fact}</p>
      </div>
    </section>
  );
}

function How({ c }: { c: Copy }) {
  return (
    <section className="lp-how" aria-labelledby="how-h">
      <h2 id="how-h">{c.how.title}</h2>
      <ol>
        {c.how.steps.map((s, k) => (
          <li key={s.order} className={`f${k}`}>
            <p className="clause"><strong>{s.order}</strong> {s.clause}</p>
            <div className="lp-ui card" data-ui><b>{s.card[0]}</b><span>{s.card[1]}</span></div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Reviews({ c }: { c: Copy }) {
  const [i, setI] = useState(0);
  const r = c.reviews.items[i]!;
  return (
    <section className="lp-reviews" aria-labelledby="rev-h">
      <div className="who">
        <h2 id="rev-h">{c.reviews.title}</h2>
        <p className="name"><span className="sample">{c.reviews.sample}</span><br />{r.name}</p>
        <p className="role">{r.role}</p>
      </div>
      <div className="quote">
        <blockquote>{r.quote}</blockquote>
        <div className="dots" role="group" aria-label={c.reviews.title}>
          {c.reviews.items.map((_, k) => <button key={k} type="button" aria-label={`${c.reviews.sample} ${k + 1}`} aria-pressed={i === k} onClick={() => setI(k)} />)}
        </div>
        <p className="note">{c.reviews.note}</p>
      </div>
    </section>
  );
}

function Pricing({ c, locale }: { c: Copy; locale: string }) {
  const [sel, setSel] = useState<PlanId>("pro");
  const [vehicles, setVehicles] = useState(20);
  const plan = PLANS[sel as Exclude<PlanId, "trial">];
  const over = plan.vehicles != null && vehicles > plan.vehicles;
  const price = monthlyEstimate(sel, vehicles);
  return (
    <section className="lp-pricing" id="pricing" aria-labelledby="pricing-h">
      <h2 id="pricing-h" className="sr-only">{c.nav.pricing}</h2>
      <div className="names" role="radiogroup" aria-label={c.nav.pricing}>
        {c.pricing.plans.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={sel === p.id} onClick={() => setSel(p.id)}>{p.name}</button>
        ))}
      </div>
      <div className="stage" aria-live="polite">
        <div key={sel} className="swap">
          <p className="price"><span>{money(price, locale)}</span> <small>{c.pricing.perMonth}</small></p>
          <p className="blurb">{c.pricing.plans.find((p) => p.id === sel)!.blurb} {c.pricing.includes[sel as "starter" | "pro" | "enterprise"]}</p>
          <p className="limits">{c.pricing.limits(plan.vehicles, plan.users, plan.jobsPerMonth)}</p>
        </div>
        <label className="slider">
          <span>{c.pricing.vehicles}: <strong>{vehicles}</strong></span>
          <input type="range" min={1} max={200} value={vehicles} onChange={(e) => setVehicles(Number(e.target.value))} aria-describedby="price-note" />
        </label>
        {over && <p className="over" role="status">{c.pricing.over.replace("{n}", String(plan.vehicles))}</p>}
        <Link href="/signup" className="lp-btn">{c.pricing.plans.find((p) => p.id === sel)!.cta}</Link>
        <p id="price-note" className="fine">{c.pricing.taxNote} {c.pricing.trial}</p>
      </div>
    </section>
  );
}

function Faq({ c }: { c: Copy }) {
  return (
    <section className="lp-faq" id="faq" aria-labelledby="faq-h">
      <h2 id="faq-h">{c.faq.title}</h2>
      <div className="items">
        {c.faq.items.map((x) => (
          <details key={x.q} name="faq"><summary>{x.q}<span className="plus" aria-hidden="true" /></summary><p>{x.a}</p></details>
        ))}
      </div>
    </section>
  );
}

function Cta({ c }: { c: Copy }) {
  return (
    <Link href="/signup" className="lp-cta" aria-label={`${c.cta.word}. ${c.cta.sentence}`}>
      <span className="s">{c.cta.sentence}</span>
      <svg className="arrow" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M14 34 34 14M18 14h16v16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="square" /></svg>
      <span className="w" aria-hidden="true">{c.cta.word}</span>
    </Link>
  );
}

function Footer({ c }: { c: Copy }) {
  const L = c.footer.links;
  const letters = "ROUTENORTH".split("");
  const heights = [100, 78, 92, 70, 100, 84, 96, 72, 88, 100];
  return (
    <footer className="lp-footer">
      <div className="mark" role="img" aria-label="RouteNorth">
        {letters.map((l, k) => <span key={k} style={{ height: `${heights[k]}%` }}>{l}</span>)}
      </div>
      <div className="cols">
        <div><h2>{c.footer.product}</h2><a href="#features">{L.features}</a><a href="#pricing">{L.pricing}</a><a href="#faq">{L.faq}</a></div>
        <div><h2>{c.footer.account}</h2><Link href="/login">{L.signIn}</Link><Link href="/signup">{L.start}</Link></div>
        <div><h2>{c.footer.legal}</h2><Link href="/terms">{L.terms}</Link><Link href="/privacy">{L.privacy}</Link><Link href="/accessibility">{L.accessibility}</Link><Link href="/security">{L.security}</Link><Link href="/status">{L.status}</Link></div>
        <div className="contact"><h2>{c.footer.contact}</h2><p>{c.footer.contactLine}</p></div>
      </div>
      <div className="base"><span>{c.footer.rights}</span><Link href="/signup" className="lp-btn lp-btn-sm">{L.start}</Link></div>
    </footer>
  );
}

export function Landing() {
  const { locale } = useI18n();
  const c = COPY[locale === "fr" ? "fr" : "en"];
  // Sections fade up once as they arrive. Without script, or with reduced motion, everything is simply visible.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const els = [...document.querySelectorAll<HTMLElement>(".lp [data-reveal]")];
    els.forEach((e) => e.classList.add("armed"));
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [locale]);
  return (
    <div className="lp" lang={locale === "fr" ? "fr" : "en"}>
      <a href="#main" className="skip-link">Skip to content</a>
      <Nav c={c} />
      <main id="main">
        <Hero c={c} />
        <div data-reveal><Features c={c} /></div>
        <div data-reveal><Showcase c={c} /></div>
        <div data-reveal><How c={c} /></div>
        <div data-reveal><Reviews c={c} /></div>
        <div data-reveal><Pricing c={c} locale={locale} /></div>
        <div data-reveal><Faq c={c} /></div>
        <Cta c={c} />
      </main>
      <Footer c={c} />
    </div>
  );
}
