/**
 * ERC-4361 (Sign-In with Ethereum) challenge messages and EOA signature verification.
 *
 * Deterministic and LLM-free. The server builds every message in one fixed layout and only that
 * layout is parsed back. Signatures are standard EIP-191 `personal_sign` signatures by an
 * externally owned account (65-byte r||s||v, low-S). Smart-contract wallets need ERC-1271
 * on-chain verification, which is not supported here.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export type ChallengePurpose = "enroll" | "rotate";
export const CHALLENGE_PURPOSES: readonly ChallengePurpose[] = ["enroll", "rotate"];

export const MAX_MESSAGE_BYTES = 2048;
const RESOURCE_PREFIX = "urn:agent-commons:pilot-wallet:";

const STATEMENTS: Readonly<Record<ChallengePurpose, string>> = Object.freeze({
  enroll:
    "Enroll this wallet as an Agent Commons pilot operator. This signature is not a transaction and costs nothing.",
  rotate:
    "Replace the Agent Commons pilot agent credential for this wallet. This signature is not a transaction and costs nothing.",
});

export interface SiweFields {
  readonly domain: string;
  /** EIP-55 checksummed address, as it appears in the message. */
  readonly address: string;
  readonly statement: string;
  readonly uri: string;
  readonly version: "1";
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime: string;
  readonly purpose: ChallengePurpose;
}

const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x" + "0".repeat(40);

/** EIP-55 mixed-case checksum encoding of a 20-byte address. */
export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak_256(encoder.encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  return out;
}

/**
 * Normalize a caller-supplied address to lower case. All-lower or all-upper hex is accepted;
 * mixed case must be a valid EIP-55 checksum. The zero address is rejected.
 */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) return null;
  const body = value.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && toChecksumAddress(value) !== value) return null;
  const lower = "0x" + body.toLowerCase();
  return lower === ZERO_ADDRESS ? null : lower;
}

export function statementFor(purpose: ChallengePurpose): string {
  return STATEMENTS[purpose];
}

/** Build the exact ERC-4361 message the wallet will sign. */
export function buildSiweMessage(f: Omit<SiweFields, "statement" | "version">): string {
  return [
    `${f.domain} wants you to sign in with your Ethereum account:`,
    toChecksumAddress(f.address),
    "",
    STATEMENTS[f.purpose],
    "",
    `URI: ${f.uri}`,
    "Version: 1",
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
    "Resources:",
    `- ${RESOURCE_PREFIX}${f.purpose}`,
  ].join("\n");
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MESSAGE_RE = new RegExp(
  [
    "^(?<domain>[A-Za-z0-9.:\\-\\[\\]]{1,253}) wants you to sign in with your Ethereum account:",
    "(?<address>0x[0-9a-fA-F]{40})",
    "",
    "(?<statement>[^\\n]{1,300})",
    "",
    "URI: (?<uri>[^\\s]{1,512})",
    "Version: (?<version>1)",
    "Chain ID: (?<chainId>[1-9][0-9]{0,15})",
    "Nonce: (?<nonce>[0-9a-f]{32})",
    "Issued At: (?<issuedAt>[0-9TZ:.\\-]{24})",
    "Expiration Time: (?<expirationTime>[0-9TZ:.\\-]{24})",
    "Resources:",
    `- ${RESOURCE_PREFIX.replace(/[.:-]/g, "\\$&")}(?<purpose>enroll|rotate)$`,
  ].join("\\n"),
);

/**
 * Parse a message in the server's fixed layout. Returns null for anything else, including
 * non-checksummed addresses, extra fields, extra whitespace or an unexpected statement.
 */
export function parseSiweMessage(message: unknown): SiweFields | null {
  if (typeof message !== "string" || encoder.encode(message).length > MAX_MESSAGE_BYTES) {
    return null;
  }
  const g = MESSAGE_RE.exec(message)?.groups;
  if (!g) return null;
  const purpose = g.purpose as ChallengePurpose;
  if (g.statement !== STATEMENTS[purpose]) return null;
  if (toChecksumAddress(g.address!) !== g.address) return null;
  if (!ISO_RE.test(g.issuedAt!) || !ISO_RE.test(g.expirationTime!)) return null;
  const chainId = Number(g.chainId);
  if (!Number.isSafeInteger(chainId)) return null;
  return {
    domain: g.domain!,
    address: g.address!,
    statement: g.statement!,
    uri: g.uri!,
    version: "1",
    chainId,
    nonce: g.nonce!,
    issuedAt: g.issuedAt!,
    expirationTime: g.expirationTime!,
    purpose,
  };
}

/** Operator actions an enrolled wallet can sign (Phase 6 spending controls). */
export type ActionPurpose = "spending-policy" | "spending-suspension" | "payout-approval";
export const ACTION_PURPOSES: readonly ActionPurpose[] = [
  "spending-policy",
  "spending-suspension",
  "payout-approval",
];
const REQUEST_PREFIX = "urn:agent-commons:request:sha256:";
const MAX_STATEMENT_CHARS = 300;

export interface ActionFields extends Omit<SiweFields, "purpose"> {
  readonly purpose: ActionPurpose;
  /** SHA-256 (hex) of the canonical JSON of the exact request being authorized. */
  readonly requestDigest: string;
}

/**
 * Build the exact ERC-4361 message for an operator action. Same layout as sign-in, but the
 * statement is a server-written, human-readable summary of the request (one line, at most 300
 * characters), and a second resource names the request digest.
 */
export function buildActionMessage(f: Omit<ActionFields, "version">): string {
  if (/[\r\n]/.test(f.statement) || f.statement.length > MAX_STATEMENT_CHARS) {
    throw new Error("action statement must be one line of at most 300 characters");
  }
  return [
    `${f.domain} wants you to sign in with your Ethereum account:`,
    toChecksumAddress(f.address),
    "",
    f.statement,
    "",
    `URI: ${f.uri}`,
    "Version: 1",
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
    "Resources:",
    `- ${RESOURCE_PREFIX}${f.purpose}`,
    `- ${REQUEST_PREFIX}${f.requestDigest}`,
  ].join("\n");
}

const escapeRe = (s: string) => s.replace(/[.:-]/g, "\\$&");
const ACTION_RE = new RegExp(
  MESSAGE_RE.source.replace(
    "(?<purpose>enroll|rotate)$",
    () =>
      `(?<purpose>spending-policy|spending-suspension|payout-approval)\\n- ${escapeRe(REQUEST_PREFIX)}` +
      "(?<requestDigest>[0-9a-f]{64})$",
  ),
);

/**
 * Parse an operator-action message in the server's fixed layout. The statement is not checked
 * here: callers compare the whole message with the digest stored when the challenge was issued.
 */
export function parseActionMessage(message: unknown): ActionFields | null {
  if (typeof message !== "string" || encoder.encode(message).length > MAX_MESSAGE_BYTES) {
    return null;
  }
  const g = ACTION_RE.exec(message)?.groups;
  if (!g) return null;
  if (toChecksumAddress(g.address!) !== g.address) return null;
  if (!ISO_RE.test(g.issuedAt!) || !ISO_RE.test(g.expirationTime!)) return null;
  const chainId = Number(g.chainId);
  if (!Number.isSafeInteger(chainId)) return null;
  return {
    domain: g.domain!,
    address: g.address!,
    statement: g.statement!,
    uri: g.uri!,
    version: "1",
    chainId,
    nonce: g.nonce!,
    issuedAt: g.issuedAt!,
    expirationTime: g.expirationTime!,
    purpose: g.purpose as ActionPurpose,
    requestDigest: g.requestDigest!,
  };
}

/** EIP-191 version 0x45 ("personal_sign") digest of a UTF-8 message. */
export function personalMessageHash(message: string): Uint8Array {
  const body = encoder.encode(message);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const buf = new Uint8Array(prefix.length + body.length);
  buf.set(prefix);
  buf.set(body, prefix.length);
  return keccak_256(buf);
}

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Recover the lower-case EOA address that produced a 65-byte personal_sign signature.
 * Returns null for malformed, high-S or unrecoverable signatures. Never throws.
 */
export function recoverPersonalSignAddress(message: string, signature: unknown): string | null {
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) return null;
  try {
    const bytes = hexToBytes(signature.slice(2));
    const v = bytes[64]!;
    const recovery = v === 27 || v === 28 ? v - 27 : v === 0 || v === 1 ? v : -1;
    if (recovery < 0) return null;
    const sig = secp256k1.Signature.fromBytes(bytes.subarray(0, 64), "compact");
    if (sig.hasHighS()) return null; // EIP-2: reject malleable signatures
    const point = sig.addRecoveryBit(recovery).recoverPublicKey(personalMessageHash(message));
    const pub = point.toBytes(false); // 0x04 || X || Y
    return "0x" + toHex(keccak_256(pub.subarray(1)).subarray(12));
  } catch {
    return null;
  }
}
