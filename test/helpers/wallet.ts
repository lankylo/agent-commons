import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { personalMessageHash } from "../../src/enrollment/siwe";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Test-only EOA from a small scalar seed. Never a real wallet key. */
export function testWallet(seed: number): { key: Uint8Array; address: string } {
  const key = new Uint8Array(32);
  new DataView(key.buffer).setUint32(28, seed);
  const pub = secp256k1.getPublicKey(key, false);
  return { key, address: "0x" + hex(keccak_256(pub.subarray(1)).subarray(12)) };
}

/** Sign like a wallet's personal_sign: r || s || v (v = 27/28). */
export function personalSign(message: string, key: Uint8Array): string {
  const sig = secp256k1.sign(personalMessageHash(message), key, {
    prehash: false,
    format: "recovered",
  });
  return "0x" + hex(sig.subarray(1)) + (27 + sig[0]!).toString(16);
}
