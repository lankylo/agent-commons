/**
 * Opt-in live verification of the httpbin seed recipe. Never run by the test
 * suite: tests exercise `checkHttpbinResponse` offline with fixed inputs. The
 * only network call is a single read-only GET to httpbin.org, made by
 * `verifyHttpbinLive` when the owner runs `npm run seed:verify:httpbin`.
 * No imports, so Node can run it directly with type stripping.
 */
export const HTTPBIN_SEED_URL = "https://httpbin.org/get?agent_commons=seed-v1";
export const HTTPBIN_EXPECTED_ARG = "seed-v1";
export const HTTPBIN_EXPECTED_FIELDS = ["url", "args", "headers", "origin"] as const;

export type HttpbinCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "rate_limited" | "unexpected"; readonly message: string };

const fail = (kind: "rate_limited" | "unexpected", message: string): HttpbinCheck => ({
  ok: false,
  kind,
  message,
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure check of a received status and body text. Never throws. */
export function checkHttpbinResponse(status: number, bodyText: string): HttpbinCheck {
  if (status === 429 || status === 503) {
    return fail("rate_limited", `HTTP ${status}: httpbin.org is rate limiting or unavailable`);
  }
  if (status !== 200) return fail("unexpected", `expected HTTP 200, received ${status}`);
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return fail("unexpected", "response body is not valid JSON");
  }
  if (!isObj(body)) return fail("unexpected", "response JSON is not an object");
  for (const f of HTTPBIN_EXPECTED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, f)) {
      return fail("unexpected", `response is missing field "${f}"`);
    }
  }
  if (typeof body.url !== "string") return fail("unexpected", '"url" is not a string');
  if (!isObj(body.args)) return fail("unexpected", '"args" is not an object');
  if (!isObj(body.headers)) return fail("unexpected", '"headers" is not an object');
  if (typeof body.origin !== "string") return fail("unexpected", '"origin" is not a string');
  if (body.args.agent_commons !== HTTPBIN_EXPECTED_ARG) {
    return fail("unexpected", `args.agent_commons is not "${HTTPBIN_EXPECTED_ARG}"`);
  }
  return { ok: true };
}

/** One read-only GET with a timeout. Network errors are reported as unexpected. */
export async function verifyHttpbinLive(
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<HttpbinCheck & { readonly verifiedAt: string }> {
  const verifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    const res = await fetchFn(HTTPBIN_SEED_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ...checkHttpbinResponse(res.status, await res.text()), verifiedAt };
  } catch (e) {
    return { ...fail("unexpected", `request failed: ${(e as Error).message}`), verifiedAt };
  }
}
