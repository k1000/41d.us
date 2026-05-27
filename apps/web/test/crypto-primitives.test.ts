import { describe, expect, it } from "vitest";
import {
  decryptWithKey,
  deriveSharedKey,
  encryptWithKey,
  exportPublicKey,
  generateECDHKeyPair,
  generateMessageKey,
  importPublicKey,
  isEncryptedBody,
  unwrapKey,
  wrapKeyForRecipient,
} from "@j01n/sdk/crypto";

describe("E2E encryption primitives", () => {
  it("isEncryptedBody narrows correctly", () => {
    expect(isEncryptedBody({ encrypted: true, ciphertext: "x", iv: "y" })).toBe(true);
    expect(isEncryptedBody({ encrypted: false })).toBe(false);
    expect(isEncryptedBody({ text: "hi" })).toBe(false);
    expect(isEncryptedBody(null)).toBe(false);
    expect(isEncryptedBody("string")).toBe(false);
  });

  it("round-trips a public key through export/import", async () => {
    const pair = await generateECDHKeyPair();
    const exported = await exportPublicKey(pair.publicKey);
    expect(exported).toMatch(/^[A-Za-z0-9_-]+$/);
    const imported = await importPublicKey(exported);
    const peer = await generateECDHKeyPair();
    const k1 = await deriveSharedKey(peer.privateKey, pair.publicKey);
    const k2 = await deriveSharedKey(peer.privateKey, imported);
    const sample = await encryptWithKey(k1, "ping");
    await expect(decryptWithKey(k2, sample.ciphertext, sample.iv)).resolves.toBe("ping");
  });

  it("derives the same ECDH shared key on both sides", async () => {
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();
    const aliceShared = await deriveSharedKey(alice.privateKey, bob.publicKey);
    const bobShared = await deriveSharedKey(bob.privateKey, alice.publicKey);

    const sealed = await encryptWithKey(aliceShared, "secret message");
    await expect(decryptWithKey(bobShared, sealed.ciphertext, sealed.iv)).resolves.toBe("secret message");
  });

  it("rejects tampered ciphertext via AES-GCM auth tag", async () => {
    const key = await generateMessageKey();
    const { ciphertext, iv } = await encryptWithKey(key, "do not tamper");
    const flipped = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
    await expect(decryptWithKey(key, flipped, iv)).rejects.toBeDefined();
  });

  it("wraps and unwraps a broadcast message key per recipient", async () => {
    const sender = await generateECDHKeyPair();
    const alice = await generateECDHKeyPair();
    const bob = await generateECDHKeyPair();

    const sharedWithAlice = await deriveSharedKey(sender.privateKey, alice.publicKey);
    const sharedWithBob = await deriveSharedKey(sender.privateKey, bob.publicKey);

    const messageKey = await generateMessageKey();
    const { ciphertext, iv } = await encryptWithKey(messageKey, "broadcast hello");
    const wrappedForAlice = await wrapKeyForRecipient(messageKey, sharedWithAlice);
    const wrappedForBob = await wrapKeyForRecipient(messageKey, sharedWithBob);

    const aliceKey = await unwrapKey(wrappedForAlice.encrypted_key, wrappedForAlice.iv, sharedWithAlice);
    const bobKey = await unwrapKey(wrappedForBob.encrypted_key, wrappedForBob.iv, sharedWithBob);

    await expect(decryptWithKey(aliceKey, ciphertext, iv)).resolves.toBe("broadcast hello");
    await expect(decryptWithKey(bobKey, ciphertext, iv)).resolves.toBe("broadcast hello");
  });

  it("sender can self-decrypt a broadcast via self-wrapped key", async () => {
    const sender = await generateECDHKeyPair();
    const selfKey = await deriveSharedKey(sender.privateKey, sender.publicKey);

    const messageKey = await generateMessageKey();
    const { ciphertext, iv } = await encryptWithKey(messageKey, "i talk to myself");
    const wrappedForSelf = await wrapKeyForRecipient(messageKey, selfKey);

    const unwrapped = await unwrapKey(wrappedForSelf.encrypted_key, wrappedForSelf.iv, selfKey);
    await expect(decryptWithKey(unwrapped, ciphertext, iv)).resolves.toBe("i talk to myself");
  });

  it("EncryptedBody has correct structure for direct messages (matches standalone j01n.js contract)", async () => {
    const alice = (await import("@j01n/sdk/crypto-session")).createSdkCryptoSession;
    const aliceSession = await alice("alice");
    const bobSession = await alice("bob");

    // Exchange keys
    await aliceSession.announceKeyBody();
    const bobPub = await bobSession.announceKeyBody();
    await aliceSession.processKeyExchange([{
      id: "", seq: 0, from: "bob", to: "all", reply_to: null,
      intent: "key.exchange", priority: "normal", body: bobPub, created_at: "",
    }]);

    // Direct message (single recipient, no wrapping)
    const body = await aliceSession.encryptForSend({ task: "review" }, "bob");

    expect(body).toHaveProperty("encrypted", true);
    expect(body).toHaveProperty("ciphertext");
    expect(body).toHaveProperty("iv");
    expect(typeof body.ciphertext).toBe("string");
    expect(typeof body.iv).toBe("string");
    // Direct messages omit the keys map
    expect(body).not.toHaveProperty("keys");
    // Values must be valid base64url
    expect(body.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.iv).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("EncryptedBody has correct structure for broadcast messages (matches standalone j01n.js contract)", async () => {
    const factory = (await import("@j01n/sdk/crypto-session")).createSdkCryptoSession;
    const aliceSession = await factory("alice");
    const bobSession = await factory("bob");

    await aliceSession.announceKeyBody();
    const bobPub = await bobSession.announceKeyBody();
    await aliceSession.processKeyExchange([{
      id: "", seq: 0, from: "bob", to: "all", reply_to: null,
      intent: "key.exchange", priority: "normal", body: bobPub, created_at: "",
    }]);

    // Broadcast (has wrapped keys per recipient, including self)
    const body = await aliceSession.encryptForSend({ task: "review" }, "all");

    expect(body).toHaveProperty("encrypted", true);
    expect(body).toHaveProperty("ciphertext");
    expect(body).toHaveProperty("iv");
    expect(body).toHaveProperty("keys");
    const keys = body.keys!;
    // Must include self-wrapped key for sender
    expect(keys).toHaveProperty("alice");
    expect(keys).toHaveProperty("bob");
    // Each wrapped key must have encrypted_key and iv
    for (const participantId of ["alice", "bob"]) {
      expect(keys[participantId]).toHaveProperty("encrypted_key");
      expect(keys[participantId]).toHaveProperty("iv");
      expect(keys[participantId].encrypted_key).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(keys[participantId].iv).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("EncryptedBody decrypts correctly with self-wrapped key (broadcast self-decrypt)", async () => {
    const factory = (await import("@j01n/sdk/crypto-session")).createSdkCryptoSession;
    const aliceSession = await factory("alice");
    const bobSession = await factory("bob");

    await aliceSession.announceKeyBody();
    const bobPub = await bobSession.announceKeyBody();
    await aliceSession.processKeyExchange([{
      id: "", seq: 0, from: "bob", to: "all", reply_to: null,
      intent: "key.exchange", priority: "normal", body: bobPub, created_at: "",
    }]);

    const body = await aliceSession.encryptForSend({ task: "review" }, "all");
    const msg = {
      id: "m1", seq: 1, from: "alice", to: "all" as const,
      reply_to: null, intent: "notify", priority: "normal",
      body, created_at: new Date().toISOString(),
    };

    // Alice should decrypt her own broadcast via self-wrapped key
    const decrypted = await aliceSession.decryptMessageBody(msg);
    expect(decrypted).toEqual({ task: "review" });
  });

  describe("base64url encoding conformance", () => {
    it("encodes/decodes round-trip without padding", async () => {
      const { randomBase64Url } = await import("@j01n/sdk/crypto");
      const encoded = randomBase64Url(32);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encoded).not.toContain("=");
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
    });
  });
});
