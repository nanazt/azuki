import { ko } from "./ko";
import { en } from "./en";

// Recursively widen literal string types to `string` so other locales can satisfy the type
type DeepStringify<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};

export type Translations = DeepStringify<typeof ko>;
export const locales = { ko, en } as const;
export type Locale = keyof typeof locales;
