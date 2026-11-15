"use client";
import { Loader2, ShieldCheck } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiSend } from "@/lib/api";

type Run = <T>(fn: () => Promise<T>) => Promise<T>;
const Ctx = createContext<Run>((fn) => fn());
export const useStepUp = (): Run => useContext(Ctx);

/**
 * Wrap a sensitive call: `await withStepUp(() => apiSend(...))`. If the server says a fresh code is needed, ask for the
 * authenticator code once, confirm it, and run the call again. Nothing is remembered in the browser: the server knows.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const ask = useCallback(() => new Promise<void>((resolve, reject) => { waiting.current = { resolve, reject }; setCode(""); setError(null); setOpen(true); }), []);
  const run = useCallback<Run>(async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (!(e instanceof ApiError) || e.code !== "step_up_required") throw e;
      await ask();
      return fn();
    }
  }, [ask]);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      await apiSend("POST", "/admin/stepup", { code: code.trim() });
      setOpen(false);
      waiting.current?.resolve(); waiting.current = null;
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? "Your session ended. Sign in again." : "That code is not right. Try the next one your app shows.");
    } finally { setBusy(false); }
  }
  function close(o: boolean) {
    if (!o && open) { setOpen(false); waiting.current?.reject(new Error("Cancelled")); waiting.current = null; }
  }

  return (
    <Ctx.Provider value={run}>
      {children}
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShieldCheck className="size-5" aria-hidden /> Confirm it is you</DialogTitle>
            <DialogDescription>This change affects a client. Enter the 6-digit code from your authenticator app. It unlocks sensitive actions for 10 minutes.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="stepup-code">Authenticator code</Label>
              <Input id="stepup-code" inputMode="numeric" autoComplete="one-time-code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={!!error || undefined} />
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>{busy && <Loader2 className="size-4 animate-spin" />} Confirm</Button>
          </form>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}
