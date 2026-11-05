"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { useI18n } from "@/lib/i18n-context";

/** A full-page message for "not found" and "something went wrong", so a wrong link never shows a bare browser or framework page. */
export function StatusPage({ kind, onRetry }: { kind: "notFound" | "error"; onRetry?: () => void }) {
  const { t } = useI18n();
  const action: ReactNode = kind === "error" && onRetry
    ? <button type="button" className="status-btn" onClick={onRetry}>{t("au_retry")}</button>
    : null;
  return (
    <main className="status-page" id="main">
      <Logo size={32} href="/" />
      <p className="status-code" aria-hidden="true">{kind === "notFound" ? "404" : "500"}</p>
      <h1>{kind === "notFound" ? t("au_404_title") : t("au_err_title")}</h1>
      <p className="status-body">{kind === "notFound" ? t("au_404_body") : t("au_err_body")}</p>
      <div className="status-actions">
        {action}
        <Link href="/live" className="status-link">{t("au_goto_app")}</Link>
      </div>
    </main>
  );
}
