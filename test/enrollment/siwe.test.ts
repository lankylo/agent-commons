import { secp256k1 } from "@noble/curves/secp256k1.js";
import { personalSign, testWallet } from "../helpers/wallet";
import { describe, expect, it } from "vitest";
import {
  buildSiweMessage,
  normalizeAddress,
  parseSiweMessage,
  personalMessageHash,
  recoverPersonalSignAddress,
  toChecksumAddress,
} from "../../src/enrollment/siwe";

// Test-only private key (scalar 1); never a real wallet key.
const KEY_ONE = new Uint8Array(32);
KEY_ONE[31] = 1;
const ADDRESS_ONE = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const fields = {
  domain: "commons.example.org",
  address: ADDRESS_ONE.toLowerCase(),
  uri: "https://commons.example.org/v1/enroll",
  chainId: 1,
  nonce: "0123456789abcdef0123456789abcdef",
  issuedAt: "2026-11-15T12:00:00.000Z",
  expirationTime: "2026-11-15T12:05:00.000Z",
  purpose: "enroll" as const,
};

describe("EIP-55 and EIP-191 primitives", () => {
  it("derives the known address of the test key", () => {
    expect(testWallet(1).address).toBe(ADDRESS_ONE.toLowerCase());
  });

  it("checksums and normalizes addresses", () => {
    expect(toChecksumAddress(ADDRESS_ONE.toLowerCase())).toBe(ADDRESS_ONE);
    expect(normalizeAddress(ADDRESS_ONE)).toBe(ADDRESS_ONE.toLowerCase());
    expect(normalizeAddress(ADDRESS_ONE.toUpperCase().replace("0X", "0x"))).toBe(
      ADDRESS_ONE.toLowerCase(),
    );
    expect(normalizeAddress(ADDRESS_ONE.replace("E", "e"))).toBeNull(); // bad checksum
    expect(normalizeAddress("0x" + "0".repeat(40))).toBeNull();
    expect(normalizeAddress("0x123")).toBeNull();
    expect(normalizeAddress(42)).toBeNull();
  });

  it("hashes personal messages per EIP-191", () => {
    expect(hex(personalMessageHash("Hello World"))).toBe(
      "a1de988600a42c4b4ab089b619297c17d53cffae5d5120d82d8a92d0bb3b78f2",
    );
  });

  it("recovers the signing EOA and rejects malformed or high-S signatures", () => {
    const sig = personalSign("hello", KEY_ONE);
    expect(recoverPersonalSignAddress("hello", sig)).toBe(ADDRESS_ONE.toLowerCase());
    // v as 0/1 is also accepted.
    const v01 = sig.slice(0, -2) + (parseInt(sig.slice(-2), 16) - 27).toString(16).padStart(2, "0");
    expect(recoverPersonalSignAddress("hello", v01)).toBe(ADDRESS_ONE.toLowerCase());
    expect(recoverPersonalSignAddress("hellO", sig)).not.toBe(ADDRESS_ONE.toLowerCase());
    expect(recoverPersonalSignAddress("hello", sig.slice(0, -2) + "1d")).toBeNull();
    expect(recoverPersonalSignAddress("hello", "0x1234")).toBeNull();
    expect(recoverPersonalSignAddress("hello", undefined)).toBeNull();
    // Flip s to n - s (high-S) and the recovery bit: same key, but malleable form is rejected.
    const n = secp256k1.Point.CURVE().n;
    const s = BigInt("0x" + sig.slice(66, 130));
    const highS = (n - s).toString(16).padStart(64, "0");
    const v = parseInt(sig.slice(-2), 16) === 27 ? "1c" : "1b";
    expect(recoverPersonalSignAddress("hello", sig.slice(0, 66) + highS + v)).toBeNull();
  });
});

describe("ERC-4361 message", () => {
  it("round-trips the server layout", () => {
    const message = buildSiweMessage(fields);
    expect(message.split("\n")[0]).toBe(
      "commons.example.org wants you to sign in with your Ethereum account:",
    );
    expect(message).toContain(`\n${ADDRESS_ONE}\n`);
    const parsed = parseSiweMessage(message);
    expect(parsed).toMatchObject({ ...fields, address: ADDRESS_ONE, version: "1" });
  });

  it("rejects any other layout", () => {
    const message = buildSiweMessage(fields);
    expect(parseSiweMessage(message + "\n")).toBeNull();
    expect(parseSiweMessage(message.replace("Version: 1", "Version: 2"))).toBeNull();
    expect(parseSiweMessage(message.replace(ADDRESS_ONE, ADDRESS_ONE.toLowerCase()))).toBeNull();
    expect(parseSiweMessage(message.replace("costs nothing", "costs a lot"))).toBeNull();
    expect(
      parseSiweMessage(message.replace("pilot-wallet:enroll", "pilot-wallet:rotate")),
    ).toBeNull();
    expect(parseSiweMessage(message.replace("Resources:", "Not Before: x\nResources:"))).toBeNull();
    expect(parseSiweMessage("x".repeat(5000))).toBeNull();
    expect(parseSiweMessage(null)).toBeNull();
  });
});
