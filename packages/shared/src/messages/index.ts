import { map } from "./map.js";
import { ops } from "./ops.js";
import { ops2 } from "./ops2.js";
import { ops3 } from "./ops3.js";
import { ops4 } from "./ops4.js";
import { ops5 } from "./ops5.js";
import { ops6 } from "./ops6.js";
import { shell } from "./shell.js";

/** Every area's strings. Add a new area file here; the compiler checks that English and French match. */
export const AREAS = [shell, map, ops, ops2, ops3, ops4, ops5, ops6] as const;

type KeysOf<T> = T extends { en: infer E } ? keyof E & string : never;
export type AreaKey = KeysOf<(typeof AREAS)[number]>;

export const AREA_MESSAGES = AREAS as readonly { en: Record<string, string>; fr: Record<string, string> }[];
