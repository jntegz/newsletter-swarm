// A small schema validator for the installer's own files. (zod is not a dependency of the
// installer; these shapes are simple enough to check by hand.)

export type Check<T> = (value: unknown, path: string) => T;

export class ShapeError extends Error {}

const fail = (path: string, expected: string): never => {
  throw new ShapeError(`${path || 'value'} should be ${expected}`);
};

export const str: Check<string> = (v, p) => (typeof v === 'string' ? v : fail(p, 'a string'));
export const num: Check<number> = (v, p) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fail(p, 'a number');
export const bool: Check<boolean> = (v, p) =>
  typeof v === 'boolean' ? v : fail(p, 'true or false');

export const oneOf =
  <const T extends string | number>(...values: T[]): Check<T> =>
  (v, p) =>
    values.includes(v as T) ? (v as T) : fail(p, `one of ${values.join(', ')}`);

export const optional =
  <T>(check: Check<T>): Check<T | undefined> =>
  (v, p) =>
    v === undefined || v === null ? undefined : check(v, p);

export const array =
  <T>(check: Check<T>): Check<T[]> =>
  (v, p) =>
    Array.isArray(v) ? v.map((item, i) => check(item, `${p}[${i}]`)) : fail(p, 'a list');

export const record =
  <T>(check: Check<T>): Check<Record<string, T>> =>
  (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, 'an object');
    const out: Record<string, T> = {};
    for (const [key, item] of Object.entries(v)) out[key] = check(item, `${p}.${key}`);
    return out;
  };

type Shape = Record<string, Check<unknown>>;
type Out<S extends Shape> = {
  [K in keyof S as undefined extends ReturnType<S[K]> ? never : K]: ReturnType<S[K]>;
} & {
  [K in keyof S as undefined extends ReturnType<S[K]> ? K : never]?: ReturnType<S[K]>;
};

/** Checks the listed keys and drops unknown ones. Optional keys that are absent stay absent. */
export const object =
  <S extends Shape>(shape: S): Check<Out<S>> =>
  (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, 'an object');
    const input = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(shape)) {
      const value = check(input[key], p ? `${p}.${key}` : key);
      if (value !== undefined) out[key] = value;
    }
    return out as Out<S>;
  };
