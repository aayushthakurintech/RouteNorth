"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { Logo } from "@/components/Logo";
import { useI18n } from "@/lib/i18n-context";

/** One look for sign in, sign up and password reset: a quiet panel on the left saying what the product does, the form on the right. */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="auth">
      <aside className="auth-side" aria-hidden={false}>
        <Link href="/" className="logo auth-logo" aria-label="RouteNorth"><Logo size={32} /></Link>
        <div className="auth-pitch">
          <p className="auth-hero">{t("au_hero_title")}</p>
          <ul className="auth-points">
            <li>{t("au_point1")}</li>
            <li>{t("au_point2")}</li>
            <li>{t("au_point3")}</li>
          </ul>
        </div>
        <svg className="auth-art" viewBox="0 0 480 220" aria-hidden="true" focusable="false">
          <path d="M20 190 C 90 190, 110 120, 170 120 S 260 170, 320 90 S 420 40, 460 30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="2 7" />
          <circle cx="20" cy="190" r="5" fill="currentColor" />
          <circle cx="170" cy="120" r="4" fill="currentColor" opacity=".7" />
          <circle cx="320" cy="90" r="4" fill="currentColor" opacity=".7" />
          <circle cx="460" cy="30" r="7" fill="#f2a900" />
        </svg>
      </aside>
      <main className="auth-main" id="main">
        <div className="auth-bar">
          <Link href="/" className="auth-back">{t("au_back_home")}</Link>
          <LanguageToggle />
        </div>
        <div className="auth-card">
          <div className="auth-brand-mobile"><Logo size={28} /></div>
          <h1>{title}</h1>
          {subtitle && <p className="auth-sub">{subtitle}</p>}
          {children}
          {footer && <p className="auth-foot">{footer}</p>}
        </div>
      </main>
    </div>
  );
}
