"use client";
import { useEffect, useRef, type ReactNode } from "react";
import type { MessageKey } from "@routenorth/shared";

/** A bottom sheet for the driver app: a native dialog, so focus and Escape work. */
export function Sheet(props: { title: string; t: (k: MessageKey) => string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="sheet" onClose={props.onClose} aria-label={props.title}>
      <h2>{props.title}</h2>
      {props.children}
      <button type="button" className="link" onClick={() => ref.current?.close()}>{props.t("closeSheet")}</button>
    </dialog>
  );
}
