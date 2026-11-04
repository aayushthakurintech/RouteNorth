"use client";
import { centsToPlain, formatCents } from "@routenorth/shared";
import { useMemo } from "react";
import { useMe } from "@/lib/me-context";

/** Money and dates the way the company wants to see them. Money arrives as whole cents; dates arrive in UTC. */
export interface Fmt {
  currency: string;
  timeZone: string;
  money: (cents: number | null | undefined) => string;
  moneyShort: (cents: number | null | undefined) => string;
  date: (iso: string | Date | null | undefined) => string;
  dateTime: (iso: string | Date | null | undefined) => string;
  num: (n: number | null | undefined, digits?: number) => string;
  pct: (n: number | null | undefined, digits?: number) => string;
}

export function makeFmt(currency: string, timeZone: string): Fmt {
  const dateOpts: Intl.DateTimeFormatOptions = { timeZone, year: "numeric", month: "short", day: "numeric" };
  const dtOpts: Intl.DateTimeFormatOptions = { ...dateOpts, hour: "2-digit", minute: "2-digit" };
  const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v));
  return {
    currency, timeZone,
    money: (c) => (c == null ? "—" : formatCents(c, currency)),
    moneyShort: (c) => (c == null ? "—" : new Intl.NumberFormat("en-CA", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(c / 100)),
    // A date-only value ("2026-11-03") is a calendar day, not an instant: show it as is in any time zone.
    date: (v) => (v == null ? "—" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Intl.DateTimeFormat("en-CA", { ...dateOpts, timeZone: "UTC" }).format(toDate(v)) : new Intl.DateTimeFormat("en-CA", dateOpts).format(toDate(v))),
    dateTime: (v) => (v == null ? "—" : new Intl.DateTimeFormat("en-CA", dtOpts).format(toDate(v))),
    num: (n, d = 0) => (n == null ? "—" : new Intl.NumberFormat("en-CA", { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n)),
    pct: (n, d = 1) => (n == null ? "—" : `${new Intl.NumberFormat("en-CA", { maximumFractionDigits: d }).format(n)}%`),
  };
}

export function useFmt(): Fmt {
  const { me } = useMe();
  const currency = me?.org.settings.currency ?? "CAD";
  const tz = me?.org.timezone ?? "America/Toronto";
  return useMemo(() => makeFmt(currency, tz), [currency, tz]);
}

/** Plain digits for CSV and spreadsheets. */
export const plainMoney = (c: number | null | undefined) => (c == null ? "" : centsToPlain(c));
