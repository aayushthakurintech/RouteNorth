"use client";
import { Modal } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { FeedbackForm } from "./FeedbackForm";

/** The feedback button in the app shell opens this. */
export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return <Modal open={open} onClose={onClose} title={t("fb_title")}><FeedbackForm onSent={onClose} /></Modal>;
}
