/**
 * Deterministic secret and personal-data scanning of validated contribution content (Phase 5).
 *
 * Runs on the already-validated Knowledge or Execution value inside the shared registry path,
 * before any D1 or R2 write, so REST, MCP, creation and versioning all get the same result.
 * Every string value, every object key and every positive safe-integer number (payment cards
 * only) is visited, regardless of family or field, so new nested fields are covered by default.
 *
 * Detectors are high-confidence only (see `docs/api.md` "Secret and personal-data scanning"): private-key blocks with a key body, recognizable token prefixes, Bearer/Basic
 * authorization values, credential query parameters, URL userinfo passwords, email addresses,
 * international (`+`) and North American phone numbers, and checksum-valid payment-card numbers.
 * Reserved documentation domains, fictional 555 numbers, published test cards and obvious
 * placeholders are allowed. Findings report the field path and category only — never the value.
 *
 * Work is bounded: depth, node count and total scanned characters are capped and every regular
 * expression has bounded repetition. Exceeding a bound fails closed. No network or LLM calls.
 */

import { detectMaliciousText } from "./malicious-patterns";

export const CONTENT_SCAN_LIMITS = {
  maxDepth: 16,
  maxNodes: 50_000,
  /** Total characters across all scanned strings and keys. */
  maxTotalChars: 2_000_000,
  maxReportedFindings: 20,
} as const;

export type ContentScanCategory =
  | "private_key"
  | "api_token"
  | "authorization_value"
  | "email_address"
  | "phone_number"
  | "payment_card";

export interface ContentScanFinding {
  /** Field path; object keys that are not plain identifiers or that were flagged are redacted. */
  readonly path: string;
  readonly category: ContentScanCategory;
}

export type ContentScanResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly findings: readonly ContentScanFinding[];
      /** Safe, value-free messages suitable for API error details. */
      readonly errors: readonly string[];
    };

const LABELS: Record<ContentScanCategory, string> = {
  private_key: "private key",
  api_token: "API token",
  authorization_value: "authorization credential",
  email_address: "email address",
  phone_number: "phone number",
  payment_card: "payment card number",
};

// ---------------------------------------------------------------------------------------------
// Placeholder heuristics

const PLACEHOLDER_WORDS =
  /example|placeholder|redacted|dummy|sample|changeme|your|xxxx|\*\*\*|<|>|\{|\}|\$|\.\.\./i;

function fewDistinct(value: string, max: number): boolean {
  return new Set(value).size <= max;
}

function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER_WORDS.test(value) || fewDistinct(value, 4) || /(.)\1{7,}/.test(value);
}

const hasLetterAndDigit = (value: string): boolean => /[A-Za-z]/.test(value) && /\d/.test(value);

// ---------------------------------------------------------------------------------------------
// Private keys

const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_BODY_TOKEN = /^[A-Za-z0-9+/]{16,}={0,2}$/;

function hasPrivateKey(text: string): boolean {
  if (!text.includes("PRIVATE KEY")) return false;
  for (const match of text.matchAll(PRIVATE_KEY_HEADER)) {
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 8192);
    const end = after.indexOf("-----END");
    const body = end === -1 ? after : after.slice(0, end);
    let bodyChars = 0;
    for (const token of body.split(/\s+/)) {
      if (
        KEY_BODY_TOKEN.test(token) &&
        /\d/.test(token) &&
        /[a-z]/.test(token) &&
        /[A-Z]/.test(token)
      ) {
        bodyChars += token.length;
      }
    }
    if (bodyChars >= 64) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// API tokens with recognizable prefixes

interface TokenRule {
  readonly pattern: RegExp;
  readonly requireLetterAndDigit?: boolean;
}

const TOKEN_RULES: readonly TokenRule[] = [
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g }, // AWS access key id
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g }, // GitHub
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,255}/g }, // GitLab
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,255}/g, requireLetterAndDigit: true }, // Slack
  { pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,255}\b/g }, // Stripe secret/restricted
  { pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g }, // Google API key
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,255}/g }, // Anthropic
  { pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,255}/g, requireLetterAndDigit: true },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { pattern: /\bhf_[A-Za-z0-9]{30,255}\b/g, requireLetterAndDigit: true }, // Hugging Face
  { pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g }, // SendGrid
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g, // JWT
  },
];

function hasApiToken(text: string): boolean {
  for (const rule of TOKEN_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const token = match[0];
      if (rule.requireLetterAndDigit && !hasLetterAndDigit(token)) continue;
      if (isPlaceholderSecret(token)) continue;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Authorization values

const BEARER = /\bBearer\s+([A-Za-z0-9._~+/-]{16,4096}=*)/gi;
const BASIC = /\bBasic\s+([A-Za-z0-9+/]{8,4096}={0,2})(?![A-Za-z0-9+/=])/gi;
const CREDENTIAL_PARAM =
  /[?&;](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd)=([^&#\s]{8,512})/gi;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s/@:]{1,256}):([^\s/@]{1,256})@/gi;
const PLACEHOLDER_PASSWORDS = new Set(["password", "pass", "passwd", "pwd", "secret", "token"]);

function decodeBasic(value: string): string | null {
  try {
    return atob(value);
  } catch {
    return null;
  }
}

function hasAuthorizationValue(text: string): boolean {
  for (const match of text.matchAll(BEARER)) {
    const token = match[1]!;
    if (hasLetterAndDigit(token) && !isPlaceholderSecret(token)) return true;
  }
  for (const match of text.matchAll(BASIC)) {
    const decoded = decodeBasic(match[1]!);
    if (decoded === null || !/^[\x20-\x7e]+$/.test(decoded)) continue;
    const separator = decoded.indexOf(":");
    if (separator <= 0 || separator === decoded.length - 1) continue;
    const password = decoded.slice(separator + 1);
    if (!PLACEHOLDER_PASSWORDS.has(password.toLowerCase()) && !isPlaceholderSecret(password)) {
      return true;
    }
  }
  for (const match of text.matchAll(CREDENTIAL_PARAM)) {
    const value = match[1]!;
    if (hasLetterAndDigit(value) && !isPlaceholderSecret(value)) return true;
  }
  for (const match of text.matchAll(URL_USERINFO)) {
    const password = match[2]!;
    if (PLACEHOLDER_PASSWORDS.has(password.toLowerCase()) || isPlaceholderSecret(password))
      continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Email addresses

const EMAIL =
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24})(?![A-Za-z0-9-])/g;
/** RFC 2606 / RFC 6761 reserved names used in documentation and tests. */
const RESERVED_EMAIL_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost|local)$/;

function hasEmail(text: string): boolean {
  if (!text.includes("@")) return false;
  for (const match of text.matchAll(EMAIL)) {
    // URL userinfo (scheme://user[:password]@host) is not an email address; passwords there are
    // handled by the authorization detector.
    if (/:\/\/[^\s/@]*$/.test(text.slice(Math.max(0, match.index - 256), match.index))) continue;
    const local = match[1]!.toLowerCase();
    const domain = match[2]!.toLowerCase();
    if (RESERVED_EMAIL_DOMAIN.test(domain)) continue;
    if (local === "git") continue; // SSH remotes such as git@github.com:org/repo.git
    if (
      /^(?:user|username|name|someone|you|your[._-]?(?:name|email))$/.test(local) &&
      /example|domain|company/.test(domain)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Phone numbers

const INTERNATIONAL_PHONE = /(?<![\w+])\+(\d[\d ().-]{6,22}\d)(?![\w])/g;
const NANP_PHONE =
  /(?<![\w.+-])(?:\(([2-9]\d{2})\) ?|([2-9]\d{2})([-. ]))([2-9]\d{2})(?:[-. ])(\d{4})(?![\w-])/g;

function isPlaceholderPhone(digits: string, nanpExchange?: string): boolean {
  if (nanpExchange === "555") return true;
  if (fewDistinct(digits, 2)) return true;
  return "01234567890123456789".includes(digits) || "98765432109876543210".includes(digits);
}

function hasPhone(text: string): boolean {
  for (const match of text.matchAll(INTERNATIONAL_PHONE)) {
    const raw = match[1]!;
    if (/[ ().-]{2,}/.test(raw)) continue;
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) continue;
    // North American fictional 555 numbers, with or without an area code.
    const fictional =
      digits.startsWith("1") && (digits.slice(1, 4) === "555" || digits.slice(4, 7) === "555");
    if (fictional || isPlaceholderPhone(digits)) continue;
    return true;
  }
  for (const match of text.matchAll(NANP_PHONE)) {
    // With a dash/dot/space separator, both separators must match.
    if (match[3] !== undefined) {
      const second = match[0].charAt(match[0].length - 5);
      if (second !== match[3]) continue;
    }
    const area = match[1] ?? match[2]!;
    const digits = `${area}${match[4]}${match[5]}`;
    if (isPlaceholderPhone(digits, match[4])) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Payment cards

const CARD_CANDIDATE =
  /(?<![\w-])(?:\d{13,19}|\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}|\d{4}([ -])\d{6}\2\d{4,5})(?![\w-])/g;

/** Published test card numbers from payment-provider documentation. */
const TEST_CARDS = new Set([
  "4242424242424242",
  "4000056655665556",
  "4111111111111111",
  "4012888888881881",
  "4222222222222",
  "4000000000000002",
  "4000000000000077",
  "4000000000009995",
  "5555555555554444",
  "5200828282828210",
  "5105105105105100",
  "2223003122003222",
  "2223000048400011",
  "378282246310005",
  "371449635398431",
  "378734493671000",
  "6011111111111117",
  "6011000990139424",
  "6011981111111113",
  "3056930009020004",
  "36227206271667",
  "30569309025904",
  "38520000023237",
  "3566002020360505",
  "3530111333300000",
  "6200000000000005",
]);

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function isCardNumber(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  if (!/^[2-6]/.test(digits)) return false; // Mastercard 2-series, Amex/Diners/JCB, Visa, MC, Discover
  if (TEST_CARDS.has(digits) || fewDistinct(digits, 2)) return false;
  return luhnValid(digits);
}

function hasPaymentCard(text: string): boolean {
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    if (isCardNumber(match[0].replace(/\D/g, ""))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Traversal

const DETECTORS: readonly [ContentScanCategory, (text: string) => boolean][] = [
  ["private_key", hasPrivateKey],
  ["api_token", hasApiToken],
  ["authorization_value", hasAuthorizationValue],
  ["email_address", hasEmail],
  ["phone_number", hasPhone],
  ["payment_card", hasPaymentCard],
];

/** Categories detected in one string. Exported for focused unit tests. */
export function detectSensitiveText(text: string): ContentScanCategory[] {
  return DETECTORS.filter(([, detect]) => detect(text)).map(([category]) => category);
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/**
 * Path segment for a contributor-supplied object key, safe to include in error messages.
 * Plain identifiers without sensitive or malicious-content findings are shown; any other key is replaced by its
 * 1-based position (`[field #n]`), or `[field]` when the position is unknown. Validators use this
 * so rejected content never echoes a field name that may itself carry a secret or personal data.
 */
export function safeFieldPath(parent: string, key: string, index?: number): string {
  if (
    PLAIN_KEY.test(key) &&
    detectSensitiveText(key).length === 0 &&
    detectMaliciousText(key).length === 0
  ) {
    return parent === "" ? key : `${parent}.${key}`;
  }
  return `${parent}[field${index === undefined ? "" : ` #${index + 1}`}]`;
}

class LimitExceeded extends Error {}

/** Scan a validated contribution value. Never returns or logs any scanned value. */
export function scanContributionContent(value: unknown): ContentScanResult {
  const findings: ContentScanFinding[] = [];
  let nodes = 0;
  let chars = 0;

  const record = (path: string, categories: readonly ContentScanCategory[]) => {
    for (const category of categories) findings.push({ path, category });
  };
  const charge = (length: number) => {
    nodes += 1;
    chars += length;
    if (nodes > CONTENT_SCAN_LIMITS.maxNodes || chars > CONTENT_SCAN_LIMITS.maxTotalChars) {
      throw new LimitExceeded();
    }
  };

  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > CONTENT_SCAN_LIMITS.maxDepth) throw new LimitExceeded();
    if (typeof node === "string") {
      charge(node.length);
      record(path, detectSensitiveText(node));
    } else if (typeof node === "number") {
      charge(0);
      if (Number.isSafeInteger(node) && node > 0 && isCardNumber(String(node))) {
        record(path, ["payment_card"]);
      }
    } else if (Array.isArray(node)) {
      charge(0);
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
    } else if (node !== null && typeof node === "object") {
      charge(0);
      Object.keys(node).forEach((key, index) => {
        charge(key.length);
        const keyFindings = detectSensitiveText(key);
        const childPath = safeFieldPath(path, key, index);
        if (keyFindings.length > 0) record(`${childPath} (field name)`, keyFindings);
        visit((node as Record<string, unknown>)[key], childPath, depth + 1);
      });
    } else {
      charge(0);
    }
  };

  try {
    visit(value, "", 0);
  } catch (error) {
    if (!(error instanceof LimitExceeded)) throw error;
    return {
      ok: false,
      findings: [],
      errors: ["content: exceeds the secret and personal-data scanning limits"],
    };
  }

  if (findings.length === 0) return { ok: true };
  const reported = findings.slice(0, CONTENT_SCAN_LIMITS.maxReportedFindings);
  const errors = reported.map(
    (f) =>
      `${f.path || "content"}: contains a possible ${LABELS[f.category]}; remove it or use a placeholder`,
  );
  if (findings.length > reported.length) {
    errors.push(`content: ${findings.length - reported.length} additional findings not shown`);
  }
  return { ok: false, findings: reported, errors };
}
