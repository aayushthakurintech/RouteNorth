"use client";
import ResourcePage from "@/components/ResourcePage";
import { useI18n } from "@/lib/i18n-context";

/** Targets such as "on-time rate at least 95% this month". Progress shows on the dashboards. */
export default function GoalsPage() {
  const { t } = useI18n();
  return <ResourcePage name="goals" />;
}
