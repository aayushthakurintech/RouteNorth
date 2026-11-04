import type { Field } from "../resources/defs.js";

/** Tiny builders for field lists (same shape the older resource engine uses, so its validation is reused). */
export const t = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "text", max: 300, ...o });
export const n = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "num", ...o });
export const i = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "int", ...o });
/** Whole cents. Always a non-negative integer; decimals are rejected so a float can never be stored. */
export const money = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "int", min: 0, max: 9_000_000_000_000, ...o });
export const d = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "date", ...o });
export const ts = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "ts", ...o });
export const ref = (key: string, col: string, to: string, o: Partial<Field> = {}): Field => ({ key, col, type: "ref", ref: to, ...o });
export const en = (key: string, col: string, values: readonly string[], o: Partial<Field> = {}): Field => ({ key, col, type: "enum", values, ...o });
export const b = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "bool", ...o });
export const tagsF = (key: string, col: string): Field => ({ key, col, type: "tags" });
export const json = (key: string, col: string, shape: "array" | "object" = "array", o: Partial<Field> = {}): Field => ({ key, col, type: "json", json: shape, ...o });
