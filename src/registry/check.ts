/** Shared, family-neutral validation primitives. Carries no family schema knowledge. */

export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Checker {
  readonly errors: string[] = [];

  err(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`);
  }

  str(
    v: unknown,
    path: string,
    max: number,
    opts: { optional?: boolean } = {},
  ): string | undefined {
    if (v === undefined && opts.optional) return undefined;
    if (typeof v !== "string" || v.trim() === "") {
      this.err(path, "must be a non-empty string");
      return undefined;
    }
    if (v.length > max) this.err(path, `exceeds ${max} characters`);
    if (CONTROL_CHARS.test(v)) this.err(path, "contains control characters");
    return v;
  }

  uri(v: unknown, path: string): void {
    if (this.str(v, path, 2048) === undefined) return;
    try {
      if (new URL(v as string).protocol !== "https:") this.err(path, "must be an https URL");
    } catch {
      this.err(path, "must be a valid URL");
    }
  }

  date(v: unknown, path: string, opts: { optional?: boolean } = {}): void {
    if (v === undefined && opts.optional) return;
    if (typeof v !== "string" || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) {
      this.err(path, "must be an ISO 8601 UTC timestamp");
    }
  }

  scalar(v: unknown, path: string): void {
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) this.err(path, "must be a finite number");
      return;
    }
    // Scalar strings are data values, not prose: held to the short-string cap.
    this.str(v, path, 200);
  }

  list(v: unknown, path: string, max: number, min = 0): unknown[] {
    if (!Array.isArray(v)) {
      this.err(path, "must be an array");
      return [];
    }
    if (v.length > max) this.err(path, `exceeds ${max} items`);
    if (v.length < min) this.err(path, `requires at least ${min} item(s)`);
    return v.slice(0, max);
  }

  obj(v: unknown, path: string, keys: readonly string[]): Obj | undefined {
    if (!isObj(v)) {
      this.err(path, "must be an object");
      return undefined;
    }
    for (const k of Object.keys(v))
      if (!keys.includes(k)) this.err(`${path}.${k}`, "unknown field");
    return v;
  }
}
