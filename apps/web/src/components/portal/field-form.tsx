"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiSend } from "@/lib/api";
import { centsToPlain, parseCents } from "@routenorth/shared";

/** One input on a form. Money is typed in dollars and sent as whole cents; dates are plain days; date-times are shown in the browser's zone and sent as UTC. */
export interface FieldSpec {
  key: string;
  label: string;
  type?: "text" | "number" | "money" | "date" | "datetime" | "select" | "textarea" | "checkbox" | "tags";
  required?: boolean;
  options?: { value: string; label: string }[];
  help?: string;
  placeholder?: string;
  step?: string;
  /** Take the whole row on wide screens. */
  wide?: boolean;
  /** Only show for these values of other fields. */
  showIf?: (v: Record<string, unknown>) => boolean;
}

type Values = Record<string, string | boolean>;

const toLocalInput = (iso: unknown): string => {
  if (!iso) return "";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Turn a stored record into the strings the inputs show. */
export function toValues(fields: FieldSpec[], rec: Record<string, unknown> | null | undefined): Values {
  const out: Values = {};
  for (const f of fields) {
    const raw = rec?.[f.key];
    if (f.type === "checkbox") out[f.key] = !!raw;
    else if (raw == null) out[f.key] = "";
    else if (f.type === "money") out[f.key] = centsToPlain(Number(raw));
    else if (f.type === "datetime") out[f.key] = toLocalInput(raw);
    else if (f.type === "date") out[f.key] = String(raw).slice(0, 10);
    else if (f.type === "tags") out[f.key] = Array.isArray(raw) ? raw.join(", ") : String(raw);
    else out[f.key] = String(raw);
  }
  return out;
}

/** Turn what was typed into the JSON the API wants. Blank means "not set" (null on edit, left out on create). */
export function toPayload(fields: FieldSpec[], v: Values, editing: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.showIf && !f.showIf(v)) continue;
    const raw = v[f.key];
    if (f.type === "checkbox") { out[f.key] = !!raw; continue; }
    const s = String(raw ?? "").trim();
    if (s === "") { if (editing) out[f.key] = null; continue; }
    if (f.type === "money") out[f.key] = parseCents(s);
    else if (f.type === "number") out[f.key] = Number(s);
    else if (f.type === "datetime") out[f.key] = new Date(s).toISOString();
    else if (f.type === "tags") out[f.key] = s.split(",").map((x) => x.trim()).filter(Boolean);
    else out[f.key] = s;
  }
  return out;
}

export function FieldInputs({ fields, values, set, errors }: { fields: FieldSpec[]; values: Values; set: (k: string, v: string | boolean) => void; errors?: Record<string, string> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.filter((f) => !f.showIf || f.showIf(values)).map((f) => {
        const id = `f-${f.key}`;
        const err = errors?.[f.key];
        const val = values[f.key];
        let control: ReactNode;
        if (f.type === "select") {
          control = (
            <Select value={String(val || "__none")} onValueChange={(x) => set(f.key, x === "__none" ? "" : x)}>
              <SelectTrigger id={id} className="w-full"><SelectValue placeholder={f.placeholder ?? "Choose"} /></SelectTrigger>
              <SelectContent>
                {!f.required && <SelectItem value="__none">Not set</SelectItem>}
                {(f.options ?? []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          );
        } else if (f.type === "textarea") control = <Textarea id={id} value={String(val ?? "")} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} rows={3} />;
        else if (f.type === "checkbox") control = <div className="flex items-center gap-2 pt-1"><Checkbox id={id} checked={!!val} onCheckedChange={(c) => set(f.key, c === true)} /><Label htmlFor={id} className="font-normal">{f.help ?? f.label}</Label></div>;
        else control = (
          <Input id={id} value={String(val ?? "")} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder}
            type={f.type === "date" ? "date" : f.type === "datetime" ? "datetime-local" : f.type === "number" ? "number" : "text"}
            inputMode={f.type === "money" ? "decimal" : undefined} step={f.type === "number" ? (f.step ?? "any") : undefined} aria-invalid={!!err} />
        );
        return (
          <div key={f.key} className={f.wide || f.type === "textarea" ? "sm:col-span-2" : undefined}>
            {f.type !== "checkbox" && <Label htmlFor={id} className="mb-1 block text-sm">{f.label}{f.required && <span className="text-destructive"> *</span>}{f.type === "money" && <span className="text-muted-foreground"> ($)</span>}</Label>}
            {control}
            {f.help && f.type !== "checkbox" && <p className="mt-1 text-xs text-muted-foreground">{f.help}</p>}
            {err && <p className="mt-1 text-xs text-destructive" role="alert">{err}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** A dialog that creates or edits one record by calling the API, and shows the server's reason when it refuses. */
export function RecordDialog({ open, onOpenChange, title, description, fields, record, method, path, extra, submitLabel, onDone, warning }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; fields: FieldSpec[];
  record?: Record<string, unknown> | null; method: "POST" | "PATCH" | "PUT"; path: string; extra?: Record<string, unknown>; submitLabel?: string;
  onDone: (result: unknown) => void; warning?: ReactNode;
}) {
  const initial = useMemo(() => toValues(fields, record), [fields, record]);
  const [values, setValues] = useState<Values>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { if (open) { setValues(initial); setError(null); setErrors({}); } }, [open, initial]);
  const editing = method === "PATCH";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const missing: Record<string, string> = {};
    for (const f of fields) if (f.required && (!f.showIf || f.showIf(values)) && f.type !== "checkbox" && String(values[f.key] ?? "").trim() === "") missing[f.key] = "Required";
    let payload: Record<string, unknown>;
    try { payload = toPayload(fields, values, editing); } catch (x) {
      setError(x instanceof Error ? x.message : "Check the numbers you typed"); return;
    }
    if (Object.keys(missing).length) { setErrors(missing); return; }
    setBusy(true); setError(null);
    try {
      const res = await apiSend<unknown>(method, path, { ...payload, ...extra });
      toast.success(editing ? "Saved" : "Added");
      onOpenChange(false);
      onDone(res);
    } catch (x) { setError(x instanceof Error ? x.message : "Could not save"); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} noValidate>
          <DialogHeader><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>
          <div className="py-4">
            {warning}
            <FieldInputs fields={fields} values={values} set={(k, v) => { setValues((s) => ({ ...s, [k]: v })); setErrors((s) => { const { [k]: _, ...rest } = s; return rest; }); }} errors={errors} />
            {error && <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive" role="alert">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : (submitLabel ?? "Save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
