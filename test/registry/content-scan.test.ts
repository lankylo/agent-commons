import { describe, expect, it } from "vitest";
import {
  CONTENT_SCAN_LIMITS,
  detectSensitiveText,
  scanContributionContent,
} from "../../src/registry/content-scan";
import { HTTPBIN_EXECUTION_SEED, HTTPBIN_KNOWLEDGE_SEED } from "../../src/seed/httpbin";

// Synthetic, non-functional values assembled at runtime so no secret-shaped literal is committed.
const rand = (n: number, alphabet = "aB3dE5gH7jK9mN2pQ4sT6vW8yZ") =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
const GITHUB_TOKEN = `ghp_${rand(36)}`;
const AWS_KEY = `AKIA${"QX7RZ2M4KD9PLT3W"}`;
const STRIPE_KEY = `sk_live_${rand(24)}`;
const JWT = `eyJ${rand(20)}.eyJ${rand(24)}.${rand(30)}`;
const PEM = [
  `-----BEGIN RSA PRIVATE KEY-----`,
  `MIIEow${rand(58)}`,
  `Qk9x2${rand(59)}`,
  `-----END RSA PRIVATE KEY-----`,
].join("\n");
const BASIC = `Basic ${btoa("svc-user:Zq8vR2mW7xLp")}`;
const CARD = "4539 1488 0343 6467"; // Luhn-valid, not a published test card
const EMAIL = "jordan.lee@acme-corp.io";
const PHONE_INTL = "+44 20 7946 0123";
const PHONE_NANP = "(212) 867-5309";

const VALUE_MARK = /Zq8vR2mW7xLp|jordan|acme-corp|4539|7946|867-5309|QX7RZ2M4KD9PLT3W/;

describe("detectSensitiveText", () => {
  it.each([
    ["private_key", PEM],
    ["api_token", `token ${GITHUB_TOKEN} here`],
    ["api_token", AWS_KEY],
    ["api_token", STRIPE_KEY],
    ["api_token", JWT],
    ["authorization_value", `Authorization: Bearer ${rand(32)}`],
    ["authorization_value", `Authorization: ${BASIC}`],
    ["authorization_value", `https://api.acme.com/v1?api_key=${rand(24)}`],
    ["authorization_value", "https://deploy:Zq8vR2mW7xLp@acme.com/repo"],
    ["email_address", `contact ${EMAIL}`],
    ["phone_number", PHONE_INTL],
    ["phone_number", PHONE_NANP],
    ["phone_number", "call 415.867.5309"],
    ["payment_card", CARD],
    ["payment_card", "4539148803436467"],
  ])("detects %s", (category, text) => {
    expect(detectSensitiveText(text)).toContain(category);
  });

  it.each([
    "Send the API key in the Authorization header as Bearer <token>.",
    "Authorization: Bearer YOUR_ACCESS_TOKEN_HERE",
    "Authorization: Bearer {{accessToken}}",
    "Authorization: Basic base64(username:password)",
    "Basic authentication is required",
    "PEM files start with -----BEGIN PRIVATE KEY----- followed by base64 data.",
    "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "AWS documentation uses AKIAIOSFODNN7EXAMPLE as the access key id.",
    `ghp_${"x".repeat(36)}`,
    "sk_test_YOUR_SECRET_KEY_PLACEHOLDER",
    "Email user@example.com or support@docs.example.org; test@foo.test",
    "git@github.com:postmanlabs/httpbin.git",
    "lodash@4.17.21 and @scope/pkg@1.2.3",
    "https://user:password@api.acme.com/",
    "https://api.acme.com/v1?api_key={API_KEY}&token=<token>",
    "Call +1-555-0100 or (212) 555-0123 for support",
    "Use test card 4242 4242 4242 4242 or 4111111111111111",
    "Timestamp 1731628800000 and id 2026-11-15T00:00:00Z +05:30",
    "sha256 fc86e9856bbaa1f0580c2cb3c979c8c19a41fb97f74fff9d28965a4fd02beb4f",
    "uuid 3fa85f64-5717-4562-b3fc-2c963f66afa6, version 10.2.3.4567",
    "Limits: 100 200 300 400 500 requests and 123-456-7890 placeholder",
    "apiKey, accessToken, password, email, phone, cardNumber, Authorization",
  ])("does not flag benign documentation: %s", (text) => {
    expect(detectSensitiveText(text)).toEqual([]);
  });
});

describe("scanContributionContent", () => {
  it("accepts the owner-tested seed fixtures of both families", () => {
    expect(scanContributionContent(HTTPBIN_KNOWLEDGE_SEED)).toEqual({ ok: true });
    expect(scanContributionContent(HTTPBIN_EXECUTION_SEED)).toEqual({ ok: true });
  });

  it("reports nested Knowledge paths without echoing values", () => {
    const content = structuredClone(HTTPBIN_KNOWLEDGE_SEED) as unknown as Record<string, unknown>;
    (content.facts as Record<string, unknown>[])[1]!.value = `owner ${EMAIL}`;
    content.records = [{ endpoint: "/get", contact: PHONE_NANP }];
    content.summary = `Use ${BASIC}`;
    content.explanation = PEM;
    (content.sources as Record<string, unknown>[])[0]!.uri =
      `https://api.acme.com/doc?token=${rand(20)}`;
    (content.evidence as Record<string, unknown>[])[0]!.uri =
      `https://deploy:Zq8vR2mW7xLp@acme.com/x`;
    (content.rights as Record<string, unknown>).rightsHolder = CARD;
    const result = scanContributionContent(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "facts[1].value: contains a possible email address; remove it or use a placeholder",
        "records[0].contact: contains a possible phone number; remove it or use a placeholder",
        "summary: contains a possible authorization credential; remove it or use a placeholder",
        "explanation: contains a possible private key; remove it or use a placeholder",
        "sources[0].uri: contains a possible authorization credential; remove it or use a placeholder",
        "evidence[0].uri: contains a possible authorization credential; remove it or use a placeholder",
        "rights.rightsHolder: contains a possible payment card number; remove it or use a placeholder",
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(VALUE_MARK);
  });

  it("reports Execution inputs and step value paths", () => {
    const content = structuredClone(HTTPBIN_EXECUTION_SEED) as unknown as Record<string, unknown>;
    content.inputs = [
      { name: "region", type: "string", required: false, allowedValues: ["eu", GITHUB_TOKEN] },
    ];
    const steps = content.steps as Record<string, unknown>[];
    steps[0]!.query = { agent_commons: { literal: STRIPE_KEY } };
    steps[0]!.headers = { X_Api: { literal: AWS_KEY } };
    steps[2]!.expected = 4539148803436467;
    const result = scanContributionContent(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings).toEqual(
      expect.arrayContaining([
        { path: "inputs[0].allowedValues[1]", category: "api_token" },
        { path: "steps[0].query.agent_commons.literal", category: "api_token" },
        { path: "steps[0].headers.X_Api.literal", category: "api_token" },
        { path: "steps[2].expected", category: "payment_card" },
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(VALUE_MARK);
  });

  it("redacts flagged or non-identifier field names in paths", () => {
    const result = scanContributionContent({ records: [{ [EMAIL]: "x", "a b": PHONE_INTL }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings).toEqual([
      { path: "records[0][field #1] (field name)", category: "email_address" },
      { path: "records[0][field #2]", category: "phone_number" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(VALUE_MARK);
  });

  it("fails closed when depth, node or character limits are exceeded", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i <= CONTENT_SCAN_LIMITS.maxDepth; i++) deep = [deep];
    const expected = {
      ok: false,
      findings: [],
      errors: ["content: exceeds the secret and personal-data scanning limits"],
    };
    expect(scanContributionContent(deep)).toEqual(expected);
    expect(scanContributionContent(new Array(CONTENT_SCAN_LIMITS.maxNodes + 1).fill(1))).toEqual(
      expected,
    );
    expect(scanContributionContent(["a".repeat(CONTENT_SCAN_LIMITS.maxTotalChars + 1)])).toEqual(
      expected,
    );
  });

  it("caps reported findings", () => {
    const many = Array.from({ length: CONTENT_SCAN_LIMITS.maxReportedFindings + 5 }, () => CARD);
    const result = scanContributionContent({ facts: many });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings).toHaveLength(CONTENT_SCAN_LIMITS.maxReportedFindings);
    expect(result.errors.at(-1)).toBe("content: 5 additional findings not shown");
  });

  it("scans large benign strings in bounded time", () => {
    const text = `${"a".repeat(500_000)}@${"1 ".repeat(200_000)}+${"9".repeat(100_000)}`;
    const started = performance.now();
    expect(scanContributionContent({ explanation: text })).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
