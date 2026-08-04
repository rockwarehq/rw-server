import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encrypted, not hashed: the plaintext has to reach SQL Server, so @rw/auth's
// one-way secrets.ts/password.ts are unusable here.
// Layout: [version:1][iv:12][tag:16][ciphertext:n]
// The key comes from the environment, never Postgres — ciphertext and key
// sharing a blast radius makes a stolen dump a stolen credential.

const ALGORITHM = "aes-256-gcm";
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

const KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";
const PREVIOUS_KEY_ENV = "INTEGRATION_ENCRYPTION_KEY_PREVIOUS";

/** A new master key as hex. Mint one per deployment and back it up WITH the database. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("hex");
}

function parseKey(value: string, name: string): Buffer {
  const key = Buffer.from(value.trim(), "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(`${name} must be ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes)`);
  }
  return key;
}

function currentKey(): Buffer {
  const value = process.env[KEY_ENV];
  if (!value) throw new Error(`${KEY_ENV} is not set — integration secrets cannot be sealed or opened`);
  return parseKey(value, KEY_ENV);
}

// Set during rotation so already-sealed secrets stay readable until re-sealed.
function previousKey(): Buffer | null {
  const value = process.env[PREVIOUS_KEY_ENV];
  return value ? parseKey(value, PREVIOUS_KEY_ENV) : null;
}

export function encryptionKeyConfigured(): boolean {
  return Boolean(process.env[KEY_ENV]);
}

/**
 * Seal a secret object for storage. `integrationId` is bound in as AAD, so a
 * ciphertext copied onto another integration row fails to open.
 */
export function sealSecret(secret: Record<string, unknown>, integrationId: string): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, currentKey(), iv);
  cipher.setAAD(Buffer.from(integrationId, "utf8"));

  const body = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  // Uint8Array, not Buffer: Prisma's Bytes column rejects Buffer's ArrayBufferLike.
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]));
}

export function openSecret(sealed: Uint8Array, integrationId: string): Record<string, unknown> {
  const buffer = Buffer.from(sealed);
  if (buffer.length <= HEADER_BYTES) throw new Error("Sealed integration secret is truncated");

  const version = buffer.readUInt8(0);
  if (version !== VERSION) throw new Error(`Unsupported sealed secret version: ${version}`);

  const iv = buffer.subarray(1, 1 + IV_BYTES);
  const tag = buffer.subarray(1 + IV_BYTES, HEADER_BYTES);
  const body = buffer.subarray(HEADER_BYTES);
  const aad = Buffer.from(integrationId, "utf8");

  let plaintext: string | null = null;
  for (const key of [currentKey(), previousKey()]) {
    if (!key) continue;
    plaintext = tryDecrypt(key, iv, tag, body, aad);
    if (plaintext !== null) break;
  }

  if (plaintext === null) {
    throw new Error("Integration secret could not be decrypted with the configured key(s)");
  }

  const parsed: unknown = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Sealed integration secret did not contain an object");
  }
  return parsed as Record<string, unknown>;
}

// Wrong key, tampered ciphertext, and wrong AAD fail identically under GCM.
function tryDecrypt(key: Buffer, iv: Buffer, tag: Buffer, body: Buffer, aad: Buffer): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
