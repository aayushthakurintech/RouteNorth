"use client";
/**
 * Motion kit. Every animation in the app comes from here, so reduced motion is honoured in one place.
 * The person's own choice (Account menu > Motion) wins over the device setting; "auto" follows the device.
 */
import { animate, AnimatePresence, LayoutGroup, motion, MotionConfig, useInView, useReducedMotion, type HTMLMotionProps } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "@/lib/theme-context";

export { AnimatePresence, LayoutGroup, motion };

/** The easing every transition shares; the same curve as `--ease` in tokens.css. */
export const EASE = [0.2, 0.7, 0.2, 1] as const;
export const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 } as const;

/** Wrap the app once: maps the Motion setting onto framer-motion's reduced-motion switch. */
export function MotionProvider({ children }: { children: ReactNode }) {
  const { motion: pref } = useTheme();
  return <MotionConfig reducedMotion={pref === "reduce" ? "always" : pref === "full" ? "never" : "user"} transition={{ duration: 0.24, ease: EASE }}>{children}</MotionConfig>;
}

/** A page body that eases in when the route changes. No exit animation: it must never make navigation feel slower. */
export function PageTransition({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <motion.div key={id} className={className} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease: EASE }}>
      {children}
    </motion.div>
  );
}

const listVariants = { hidden: {}, show: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } } };
const itemVariants = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE } } };

/** Children rise in one after another. Wrap each child in StaggerItem. */
export function Stagger({ children, className, as = "div", ...rest }: { children: ReactNode; className?: string; as?: "div" | "ul" | "ol" | "section" } & Omit<HTMLMotionProps<"div">, "variants" | "initial" | "animate" | "children" | "className">) {
  const M = motion[as] as typeof motion.div;
  return <M className={className} variants={listVariants} initial="hidden" animate="show" {...rest}>{children}</M>;
}
export function StaggerItem({ children, className, as = "div", ...rest }: { children: ReactNode; className?: string; as?: "div" | "li" | "article" | "section" } & Omit<HTMLMotionProps<"div">, "variants" | "children" | "className">) {
  const M = motion[as] as typeof motion.div;
  return <M className={className} variants={itemVariants} {...rest}>{children}</M>;
}

/** Fades up once when scrolled into view. */
export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  return <motion.div ref={ref} className={className} initial={{ opacity: 0, y: 14 }} animate={seen ? { opacity: 1, y: 0 } : undefined} transition={{ duration: 0.4, ease: EASE, delay }}>{children}</motion.div>;
}

/**
 * A number that counts up to its value once, when it first shows. Text and layout are fixed-width digits
 * (tabular), so nothing jumps. With reduced motion it simply shows the value.
 */
export function CountUp({ value, format = (n: number) => Math.round(n).toLocaleString(), duration = 0.9, className }: { value: number; format?: (n: number) => string; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const prev = useRef(reduce ? value : 0);
  useEffect(() => {
    if (!inView) return;
    if (reduce) { setShown(value); prev.current = value; return; }
    const controls = animate(prev.current, value, { duration, ease: EASE, onUpdate: (v) => setShown(v), onComplete: () => { prev.current = value; } });
    return () => controls.stop();
  }, [inView, value, duration, reduce]);
  return <span ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums" }}>{format(inView ? shown : reduce ? value : 0)}</span>;
}

/** A status dot that breathes while something is live. Static when motion is reduced. */
export function PulseDot({ color = "var(--amber)", size = 8, live = true }: { color?: string; size?: number; live?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <span aria-hidden style={{ position: "relative", display: "inline-block", width: size, height: size, flex: "none" }}>
      {live && !reduce && <motion.span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color }} animate={{ scale: [1, 2.6], opacity: [0.5, 0] }} transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }} />}
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color }} />
    </span>
  );
}
