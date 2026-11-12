"use client";
import { passwordProblem, passwordStrength, type MessageKey, type PasswordContext } from "@routenorth/shared";
import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n-context";

/** A password input with a show/hide switch and, when `meter` is on, a strength bar plus the reason a password is refused. */
export function PasswordField({ label, value, onChange, autoComplete, meter = false, context, hint, id, invalid }: {
  label: string; value: string; onChange: (v: string) => void; autoComplete: "current-password" | "new-password";
  meter?: boolean; context?: PasswordContext; hint?: string; id?: string; invalid?: boolean;
}) {
  const { t } = useI18n();
  const auto = useId();
  const fid = id ?? auto;
  const [show, setShow] = useState(false);
  const strength = meter ? passwordStrength(value, context) : 0;
  const problem = meter && value ? passwordProblem(value, context) : null;
  return (
    <div className="pw-field">
      <label htmlFor={fid}>{label}</label>
      <div className="pw-wrap">
        <input id={fid} type={show ? "text" : "password"} autoComplete={autoComplete} required value={value} maxLength={200} minLength={meter ? 10 : undefined}
          aria-invalid={invalid || (problem !== null && problem !== "short") || undefined} aria-describedby={meter ? `${fid}-help` : undefined}
          onChange={(e) => onChange(e.target.value)} spellCheck={false} autoCapitalize="none" />
        <button type="button" className="pw-toggle" aria-pressed={show} onClick={() => setShow(!show)}>{show ? t("au_hide") : t("au_show")}</button>
      </div>
      {meter && (
        <div id={`${fid}-help`} className="pw-help" aria-live="polite">
          <div className="pw-bar" data-level={strength} aria-hidden="true"><i /><i /><i /><i /></div>
          <span className="pw-state">{value ? t(`au_pw_${strength}` as MessageKey) : ""}</span>
          <span className="pw-msg">{problem ? t(`au_pw_${problem}` as MessageKey) : hint ?? ""}</span>
        </div>
      )}
    </div>
  );
}
