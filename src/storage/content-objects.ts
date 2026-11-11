/**
 * Immutable content-object convention for contribution bodies in R2.
 *
 * Key:      `contributions/sha256/<64 lowercase hex>`; the hash is the SHA-256 of the
 *           stored bytes, which for a contribution are the canonical JSON bytes, so the
 *           key equals the contribution `contentHash` from `hashContribution`.
 * Metadata: HTTP content-type `application/json`; custom metadata `family`,
 *           `contentType` (registry content type, valid for the family) and `sha256`.
 * Objects are write-once: never overwritten, never deleted by this module.
 * Stored content is untrusted; callers must validate by family before writing.
 * This module only touches a bucket binding it is handed; it creates no buckets.
 */
import { type ContributionFamily, isContributionFamily } from "../registry/envelope";
import { maxReviewIntervalDays } from "../registry/review-intervals";

/** Bucket binding for contribution content. Bound only in local/dev config today. */
export interface ContentStorageEnv {
  CONTENT_BUCKET: R2Bucket;
}

export const CONTENT_KEY_PREFIX = "contributions/sha256/";
export const CONTENT_HTTP_TYPE = "application/json";
const HASH_RE = /^[0-9a-f]{64}$/;

export class ContentObjectError extends Error {}

export interface ContentObjectMeta {
  readonly family: ContributionFamily;
  readonly contentType: string;
  readonly sha256: string;
}

export interface StoredContentObject extends ContentObjectMeta {
  readonly key: string;
  readonly bytes: Uint8Array;
}

export function contentObjectKey(sha256: string): string {
  if (!HASH_RE.test(sha256)) throw new ContentObjectError("invalid sha256 hash");
  return CONTENT_KEY_PREFIX + sha256;
}

export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function readMeta(
  custom: Record<string, string> | undefined,
  httpType: string | undefined,
): ContentObjectMeta {
  const family = custom?.["family"];
  const contentType = custom?.["contentType"];
  const sha256 = custom?.["sha256"];
  if (
    httpType !== CONTENT_HTTP_TYPE ||
    !isContributionFamily(family) ||
    maxReviewIntervalDays(family, contentType) === undefined ||
    typeof contentType !== "string" ||
    typeof sha256 !== "string" ||
    !HASH_RE.test(sha256)
  ) {
    throw new ContentObjectError("stored object metadata is missing or invalid");
  }
  return { family, contentType, sha256 };
}

export interface PutResult {
  readonly key: string;
  readonly sha256: string;
  /** false when an identical object already existed (no write happened). */
  readonly created: boolean;
}

/**
 * Write bytes under their hash-derived key, once. Identical content resolves to the
 * same key and is not rewritten. Existing metadata that disagrees is a conflict.
 */
export async function putContentObject(
  bucket: R2Bucket,
  input: { family: ContributionFamily; contentType: string; bytes: Uint8Array },
): Promise<PutResult> {
  const { family, contentType, bytes } = input;
  if (!isContributionFamily(family)) throw new ContentObjectError("unknown family");
  if (maxReviewIntervalDays(family, contentType) === undefined) {
    throw new ContentObjectError(`content type "${contentType}" is not defined for ${family}`);
  }
  if (bytes.byteLength === 0) throw new ContentObjectError("empty content");
  const sha256 = await sha256OfBytes(bytes);
  const key = contentObjectKey(sha256);

  const existing = await bucket.head(key);
  if (existing) {
    checkSame(existing, { family, contentType, sha256 });
    return { key, sha256, created: false };
  }
  // etagDoesNotMatch "*" makes the write conditional: it fails (null) if the key exists.
  const written = await bucket.put(key, bytes, {
    httpMetadata: { contentType: CONTENT_HTTP_TYPE },
    customMetadata: { family, contentType, sha256 },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written === null) {
    // Lost a race with an identical concurrent write; verify it is the same object.
    const raced = await bucket.head(key);
    if (!raced) throw new ContentObjectError("conditional write failed");
    checkSame(raced, { family, contentType, sha256 });
    return { key, sha256, created: false };
  }
  return { key, sha256, created: true };
}

function checkSame(obj: R2Object, expected: ContentObjectMeta): void {
  const meta = readMeta(obj.customMetadata, obj.httpMetadata?.contentType);
  if (
    meta.sha256 !== expected.sha256 ||
    meta.family !== expected.family ||
    meta.contentType !== expected.contentType
  ) {
    throw new ContentObjectError("existing object has conflicting metadata");
  }
}

/** Retrieve by hash. Re-verifies bytes against the key and metadata; null when absent. */
export async function getContentObject(
  bucket: R2Bucket,
  sha256: string,
): Promise<StoredContentObject | null> {
  const key = contentObjectKey(sha256);
  const obj = await bucket.get(key);
  if (!obj) return null;
  const meta = readMeta(obj.customMetadata, obj.httpMetadata?.contentType);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (meta.sha256 !== sha256 || (await sha256OfBytes(bytes)) !== sha256) {
    throw new ContentObjectError("stored bytes do not match hash-derived key");
  }
  return { key, bytes, ...meta };
}
