import { shell } from "./shell.js";

/** Every area's strings. Add a new area file here; the compiler checks that English and French match. */
export const AREAS = [shell] as const;

type KeysOf<T> = T extends { en: infer E } ? keyof E & string : never;
export type AreaKey = KeysOf<(typeof AREAS)[number]>;

export const AREA_MESSAGES = AREAS as readonly { en: Record<string, string>; fr: Record<string, string> }[];
