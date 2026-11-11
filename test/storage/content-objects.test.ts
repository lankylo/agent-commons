import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/registry/content-hash";
import {
  ContentObjectError,
  CONTENT_KEY_PREFIX,
  contentObjectKey,
  getContentObject,
  putContentObject,
  sha256OfBytes,
  type ContentStorageEnv,
} from "../../src/storage/content-objects";

// Local R2 emulation (Miniflare) with throwaway persistence; never touches a real bucket.
let proxy: PlatformProxy<ContentStorageEnv>;
let dir: string;
let bucket: R2Bucket;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "r2-smoke-"));
  proxy = await getPlatformProxy<ContentStorageEnv>({
    configPath: "wrangler.r2-local.jsonc",
    persist: { path: dir },
  });
  bucket = proxy.env.CONTENT_BUCKET;
});
afterAll(async () => {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const enc = (s: string) => new TextEncoder().encode(s);
const body = '{"family":"knowledge","title":"smoke"}';

describe("content-object keys", () => {
  it("derives the key from a lowercase sha256 only", async () => {
    const h = await sha256OfBytes(enc(body));
    expect(contentObjectKey(h)).toBe(CONTENT_KEY_PREFIX + h);
    for (const bad of ["", "abc", h.toUpperCase(), `../${h}`, h + "0"]) {
      expect(() => contentObjectKey(bad)).toThrow(ContentObjectError);
    }
  });
  it("equals the registry hash of the same canonical text", async () => {
    expect(await sha256OfBytes(enc(body))).toBe(await sha256Hex(body));
  });
});

describe("local R2 smoke test", () => {
  it("writes, retrieves by hash key, verifies bytes and metadata", async () => {
    const bytes = enc(body);
    const put = await putContentObject(bucket, {
      family: "knowledge",
      contentType: "api-limits",
      bytes,
    });
    expect(put.created).toBe(true);
    expect(put.key).toBe(CONTENT_KEY_PREFIX + (await sha256OfBytes(bytes)));

    const got = await getContentObject(bucket, put.sha256);
    expect(got).not.toBeNull();
    expect(Array.from(got!.bytes)).toEqual(Array.from(bytes));
    expect(got).toMatchObject({
      key: put.key,
      family: "knowledge",
      contentType: "api-limits",
      sha256: put.sha256,
    });
    const head = await bucket.head(put.key);
    expect(head?.httpMetadata?.contentType).toBe("application/json");
  });

  it("resolves identical content to the same single object", async () => {
    const bytes = enc('{"family":"execution","title":"dup"}');
    const a = await putContentObject(bucket, {
      family: "execution",
      contentType: "api-recipe",
      bytes,
    });
    const b = await putContentObject(bucket, {
      family: "execution",
      contentType: "api-recipe",
      bytes: enc('{"family":"execution","title":"dup"}'),
    });
    expect(b.key).toBe(a.key);
    expect([a.created, b.created]).toEqual([true, false]);
    const listed = await bucket.list({ prefix: a.key });
    expect(listed.objects).toHaveLength(1);
  });

  it("never overwrites: conflicting metadata for the same bytes is rejected", async () => {
    const bytes = enc('{"family":"knowledge","title":"conflict"}');
    await putContentObject(bucket, { family: "knowledge", contentType: "api-limits", bytes });
    await expect(
      putContentObject(bucket, { family: "knowledge", contentType: "api-reference", bytes }),
    ).rejects.toThrow(/conflicting/);
    const got = await getContentObject(bucket, await sha256OfBytes(bytes));
    expect(got?.contentType).toBe("api-limits");
  });

  it("different bytes get different keys; absent hash returns null", async () => {
    const x = await putContentObject(bucket, {
      family: "knowledge",
      contentType: "api-limits",
      bytes: enc("one"),
    });
    const y = await putContentObject(bucket, {
      family: "knowledge",
      contentType: "api-limits",
      bytes: enc("two"),
    });
    expect(x.key).not.toBe(y.key);
    expect(await getContentObject(bucket, "0".repeat(64))).toBeNull();
  });

  it("rejects invalid family, content type for the family, and empty bytes", async () => {
    const base = { bytes: enc("z") };
    await expect(
      putContentObject(bucket, { ...base, family: "nope" as never, contentType: "api-limits" }),
    ).rejects.toThrow(ContentObjectError);
    await expect(
      putContentObject(bucket, { ...base, family: "execution", contentType: "api-limits" }),
    ).rejects.toThrow(/not defined/);
    await expect(
      putContentObject(bucket, {
        family: "knowledge",
        contentType: "api-limits",
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow(/empty/);
  });

  it("detects tampered stored bytes on retrieval", async () => {
    const h = await sha256OfBytes(enc("orig"));
    await bucket.put(contentObjectKey(h), enc("tampered"), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { family: "knowledge", contentType: "api-limits", sha256: h },
    });
    await expect(getContentObject(bucket, h)).rejects.toThrow(/do not match/);
  });
});
