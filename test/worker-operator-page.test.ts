import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { OPERATOR_CLIENT } from "../src/enrollment/operator-page";
import worker from "../src/index";

const DOMAIN = "commons.example.org";
const env = {
  ENROLLMENT: "on",
  ENROLLMENT_DOMAIN: DOMAIN,
  ENROLLMENT_URI: `https://${DOMAIN}/`,
  ENROLLMENT_CHAIN_ID: "1",
};

const get = (path: string, values: Record<string, unknown> = env, method = "GET") =>
  worker.fetch(new Request(`https://${DOMAIN}${path}`, { method }), values as never);

describe("operator actions page", () => {
  it("is unavailable unless enrollment is enabled", async () => {
    for (const disabled of [{}, { ...env, ENROLLMENT: "off" }]) {
      for (const path of ["/pilot/operator", "/pilot/operator.js"]) {
        expect((await get(path, disabled)).status).toBe(404);
      }
    }
    expect((await get("/pilot/operator", { ...env, ENROLLMENT_URI: "not a url" })).status).toBe(
      503,
    );
    expect((await get("/pilot/operator", env, "POST")).status).toBe(404);
  });

  it("serves the page and its script with a strict content security policy", async () => {
    const page = await get("/pilot/operator");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    const html = await page.text();
    for (const purpose of ["spending-policy", "spending-suspension", "payout-approval"]) {
      expect(html).toContain(`value="${purpose}"`);
    }
    expect(html).toContain('src="/pilot/operator.js"');

    const script = await get("/pilot/operator.js");
    expect(script.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
    const js = await script.text();
    expect(js).toBe(OPERATOR_CLIENT);
  });

  it("only asks the wallet for accounts and personal_sign, and posts to the signed-action routes", () => {
    // The script parses as JavaScript.
    expect(() => new Script(OPERATOR_CLIENT)).not.toThrow();
    const methods = [...OPERATOR_CLIENT.matchAll(/method: "([a-z_A-Z]+)"/g)].map((m) => m[1]);
    expect(new Set(methods)).toEqual(new Set(["eth_requestAccounts", "personal_sign", "POST"]));
    for (const path of [
      "/v1/enroll/spending-challenge",
      "/v1/enroll/spending-policy",
      "/v1/enroll/spending-suspension",
      "/v1/enroll/payout-approval",
    ]) {
      expect(OPERATOR_CLIENT).toContain(path);
    }
    expect(OPERATOR_CLIENT).not.toMatch(/eth_sendTransaction|eth_sign"|privateKey|mnemonic/);
  });
});
