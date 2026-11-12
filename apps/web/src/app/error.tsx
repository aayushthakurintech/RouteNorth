"use client";
import { StatusPage } from "@/components/auth/StatusPage";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <StatusPage kind="error" onRetry={reset} />;
}
