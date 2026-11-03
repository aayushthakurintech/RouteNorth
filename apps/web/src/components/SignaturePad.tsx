"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface SignaturePadHandle {
  isEmpty(): boolean;
  clear(): void;
  toBlob(): Promise<Blob | null>;
}

/** Finger/stylus signature canvas. Pointer events cover touch, pen and mouse. */
export const SignaturePad = forwardRef<SignaturePadHandle, { label: string; onChange?: (empty: boolean) => void }>(
  function SignaturePad({ label, onChange }, ref) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);
    const empty = useRef(true);

    // The canvas may be laid out after mount (inside a <dialog> that opens later), so size it
    // whenever it gets a real size rather than once on mount.
    useEffect(() => {
      const c = canvas.current!;
      const setup = () => {
        if (!c.clientWidth || !c.clientHeight || !empty.current) return;
        const ratio = window.devicePixelRatio || 1;
        c.width = c.clientWidth * ratio;
        c.height = c.clientHeight * ratio;
        const ctx = c.getContext("2d")!;
        ctx.scale(ratio, ratio);
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#0f172a";
      };
      setup();
      const ro = new ResizeObserver(setup);
      ro.observe(c);
      return () => ro.disconnect();
    }, []);

    const point = (e: React.PointerEvent) => {
      const r = canvas.current!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    useImperativeHandle(ref, () => ({
      isEmpty: () => empty.current,
      clear() {
        const c = canvas.current!;
        c.getContext("2d")!.clearRect(0, 0, c.clientWidth, c.clientHeight);
        empty.current = true;
        onChange?.(true);
      },
      toBlob: () => new Promise((resolve) => canvas.current!.toBlob(resolve, "image/png")),
    }));

    return (
      <canvas
        ref={canvas} className="sigpad" role="img" aria-label={label}
        onPointerDown={(e) => {
          drawing.current = true;
          canvas.current!.setPointerCapture(e.pointerId);
          const ctx = canvas.current!.getContext("2d")!;
          const { x, y } = point(e);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); ctx.stroke();
          if (empty.current) { empty.current = false; onChange?.(false); }
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = canvas.current!.getContext("2d")!;
          const { x, y } = point(e);
          ctx.lineTo(x, y); ctx.stroke();
        }}
        onPointerUp={() => { drawing.current = false; }}
        onPointerCancel={() => { drawing.current = false; }}
      />
    );
  },
);
