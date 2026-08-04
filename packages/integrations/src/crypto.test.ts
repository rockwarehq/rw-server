import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateEncryptionKey, openSecret, sealSecret } from "./crypto.js";

const KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";
const PREVIOUS_KEY_ENV = "INTEGRATION_ENCRYPTION_KEY_PREVIOUS";

describe("integration secret sealing", () => {
  const original = { key: process.env[KEY_ENV], previous: process.env[PREVIOUS_KEY_ENV] };

  beforeEach(() => {
    process.env[KEY_ENV] = generateEncryptionKey();
    delete process.env[PREVIOUS_KEY_ENV];
  });

  afterEach(() => {
    if (original.key === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = original.key;
    if (original.previous === undefined) delete process.env[PREVIOUS_KEY_ENV];
    else process.env[PREVIOUS_KEY_ENV] = original.previous;
  });

  it("round-trips a secret", () => {
    const sealed = sealSecret({ password: "hunter2" }, "integration-1");
    expect(openSecret(sealed, "integration-1")).toEqual({ password: "hunter2" });
  });

  it("does not store the plaintext", () => {
    const sealed = sealSecret({ password: "hunter2" }, "integration-1");
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("hunter2");
  });

  it("produces a different ciphertext each time", () => {
    const first = sealSecret({ password: "hunter2" }, "integration-1");
    const second = sealSecret({ password: "hunter2" }, "integration-1");
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });

  it("rejects a ciphertext moved to another integration id", () => {
    const sealed = sealSecret({ password: "hunter2" }, "integration-1");
    expect(() => openSecret(sealed, "integration-2")).toThrow(/could not be decrypted/);
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = sealSecret({ password: "hunter2" }, "integration-1");
    sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 0xff;
    expect(() => openSecret(sealed, "integration-1")).toThrow(/could not be decrypted/);
  });

  it("rejects a truncated ciphertext", () => {
    const sealed = sealSecret({ password: "hunter2" }, "integration-1");
    expect(() => openSecret(sealed.subarray(0, 8), "integration-1")).toThrow(/truncated/);
  });

  it("fails when the key changes without rotation", () => {
    const sealed = sealSecret({ password: "hunter2" }, "integration-1");
    process.env[KEY_ENV] = generateEncryptionKey();
    expect(() => openSecret(sealed, "integration-1")).toThrow(/could not be decrypted/);
  });

  it("opens secrets sealed with the previous key during rotation", () => {
    const originalKey = process.env[KEY_ENV] as string;
    const sealed = sealSecret({ password: "hunter2" }, "integration-1");

    process.env[KEY_ENV] = generateEncryptionKey();
    process.env[PREVIOUS_KEY_ENV] = originalKey;

    expect(openSecret(sealed, "integration-1")).toEqual({ password: "hunter2" });
  });

  it("requires a configured key", () => {
    delete process.env[KEY_ENV];
    expect(() => sealSecret({ password: "hunter2" }, "integration-1")).toThrow(/is not set/);
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env[KEY_ENV] = "abcd";
    expect(() => sealSecret({ password: "hunter2" }, "integration-1")).toThrow(/64 hex characters/);
  });
});
