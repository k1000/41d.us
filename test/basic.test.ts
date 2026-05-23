import { MAX_BODY_BYTES } from "../src/constants";
import { describe, expect, it } from "vitest";
import { orchestrationMarkdown, sdkMarkdown } from "../src/client-assets";
import app from "../src/index";
import {
  decryptWithKey,
  deriveSharedKey,
  encryptWithKey,
  exportPublicKey,
  generateECDHKeyPair,
  generateMessageKey,
  hashJoinSecret,
  importPublicKey,
  isEncryptedBody,
  randomBase64Url,
  unwrapKey,
  wrapKeyForRecipient,
} from "../src/crypto";
import { prefersMarkdown } from "../src/format";
import { homeMarkdown, homePage, inviteInstructionsMarkdown } from "../src/html";
import { securityMarkdown, securityPage } from "../src/security";
import { skillMarkdown, skillPage } from "../src/skill";

describe("homePage", () => {
  it("presents the project and the end-to-end encryption promise", () => {
    const html = homePage();

    expect(html).toContain("Secure agentic collaboration space.");
    expect(html).toContain("End-to-end encryption via client-side ECDH + AES-256-GCM.");
    expect(html).toContain("short-lived encrypted romantic adventure");
    expect(html).toContain("/skill");
    expect(html).toContain("/skill/SKILL.md");
    expect(html).not.toContain("/client/agent.py");
  });

  it("has markdown for agents", () => {
    const markdown = homeMarkdown();

    expect(markdown).toContain("# 41d.us");
    expect(markdown).toContain("Secure agentic collaboration space.");
    expect(markdown).toContain("End-to-end encryption via client-side ECDH + AES-256-GCM.");
    expect(markdown).not.toContain("https://41d.us/client/agent.py");
  });

  it("detects markdown-friendly agents", () => {
    expect(prefersMarkdown(new Request("https://41d.us/", { headers: { accept: "text/markdown" } }))).toBe(true);
    expect(prefersMarkdown(new Request("https://41d.us/?format=md"))).toBe(true);
    expect(prefersMarkdown(new Request("https://41d.us/", { headers: { "user-agent": "curl/8.0" } }))).toBe(true);
    expect(prefersMarkdown(new Request("https://41d.us/", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } }))).toBe(false);
  });
});

describe("skill page", () => {
  it("links to the downloadable skill", () => {
    expect(skillPage()).toContain("/skill/SKILL.md");
    expect(skillMarkdown).toContain("# 41d.us Agent Rendezvous");
    expect(skillMarkdown).toContain("collab space");
    expect(skillMarkdown).toContain("https://41d.us/client/SDK.md");
    expect(skillMarkdown).not.toContain("https://41d.us/client/agent.py");
    expect(skillMarkdown).not.toContain("const invite = await createInvite");
  });
});

describe("public client assets", () => {
  it("serves SDK docs content", () => {
    expect(sdkMarkdown).toContain("collab space");
    expect(sdkMarkdown).toContain("ORCHESTRATION.md");
    expect(orchestrationMarkdown).toContain("reservation.claim");
    expect(orchestrationMarkdown).toContain("review.result");
    expect(sdkMarkdown).not.toContain("python examples/agent.py");
  });
});

describe("invite instructions", () => {
  it("shows a direct Agent B join command", () => {
    const markdown = inviteInstructionsMarkdown("abc", "https://41d.us/r/abc", "secret");

    expect(markdown).toContain("ROOM_URL='https://41d.us/r/abc'");
    expect(markdown).toContain("JOIN_SECRET='secret'");
    expect(markdown).toContain("curl -sS -X PUT \"$ROOM_URL/participants/$ME\"");
    expect(markdown).toContain("Plain curl examples send plaintext");
  });

  it("escapes HTML special characters in the page version", async () => {
    const { inviteInstructionsPage } = await import("../src/html");
    const html = inviteInstructionsPage("abc<script>", "https://41d.us/r/x", "sec&ret");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("sec&amp;ret");
  });
});

describe("invite creation", () => {
  it("includes the invitation instructions URL in invite responses", async () => {
    const state = new Map<string, unknown>();
    const env = {
      RENDEZVOUS: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (_url: string, init?: RequestInit) => {
            if (init?.body) state.set("body", init.body);
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        }),
      },
    };

    const response = await app.fetch(new Request("https://41d.us/invites", { method: "POST", body: JSON.stringify({ host_id: "CalmPhoenix", room_name: "review room", max_participants: 7, first_message: "Review the Room API." }) }), env);
    const body = (await response.json()) as { intro: string; next_step: string; room: { name: string; host_id: string; max_participants: number; purpose?: { text?: string } }; api: { events: string; status: string; close: string }; quickstart: { join: string; events: string }; host_id?: string; max_participants?: number; room_url: string; instructions?: string; readme?: string; skill: string };

    expect(body.intro).toContain("invited by CalmPhoenix");
    expect(body.room).toEqual({ name: "review room", host_id: "CalmPhoenix", max_participants: 7, purpose: { text: "Review the Room API." } });
    expect(body.host_id).toBeUndefined();
    expect(body.max_participants).toBeUndefined();
    expect(body.next_step).toBe("Open room_url and follow the Join now command.");
    expect(body.api.events).toMatch(/\/events$/);
    expect(body.api.status).toMatch(/\/status$/);
    expect(body.api.close).toBe(body.room_url);
    expect(body.quickstart.join).toContain("curl -sS -X PUT");
    expect(body.quickstart.events).toContain("curl -N");
    expect(body.room_url).toMatch(/^https:\/\/41d\.us\/r\//);
    expect(body.instructions).toBeUndefined();
    expect(body.readme).toBeUndefined();
    expect(body.skill).toBe("https://41d.us/skill/SKILL.md");
  });
});

describe("invite secret helpers", () => {
  it("generates base64url invite material", () => {
    expect(randomBase64Url(16)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomBase64Url(32)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes join secrets deterministically per invite", async () => {
    await expect(hashJoinSecret("invite", "secret")).resolves.toBe(await hashJoinSecret("invite", "secret"));
    await expect(hashJoinSecret("invite", "secret")).resolves.not.toBe(await hashJoinSecret("other", "secret"));
  });
});

describe("byte-size helpers", () => {
  it("MAX_BODY_BYTES is 16 KB", () => {
    expect(MAX_BODY_BYTES).toBe(16 * 1024);
  });

  // Verify TextEncoder counts actual UTF-8 bytes, not JS string length.
  // JSON.stringify serialises the body to a string first, so .length reflects UTF-16 code units.
  it("TextEncoder correctly distinguishes string length from byte count", () => {
    // A string of repeated emoji: each emoji is 2 UTF-16 code units but 4 UTF-8 bytes.
    // JSON produces escape sequences for non-ASCII, so compare the raw string before stringify.
    const emoji = "\ud83d\ude00\ud83d\ude00\ud83d\ude00";
    const rawLen = emoji.length; // 6 UTF-16 code units
    const utf8Bytes = new TextEncoder().encode(emoji).length; // 12 UTF-8 bytes (4 each)
    expect(utf8Bytes).toBe(rawLen * 2); // UTF-8 is 2× for emoji
  });

  it("TextEncoder correctly sizes a body at the boundary", () => {
    // Single-byte chars: n chars → n UTF-8 bytes.
    expect(new TextEncoder().encode("x".repeat(MAX_BODY_BYTES)).length).toBe(MAX_BODY_BYTES);
    expect(new TextEncoder().encode("x".repeat(MAX_BODY_BYTES + 1)).length).toBe(MAX_BODY_BYTES + 1);
  });
});

describe("escapeHtml", () => {
  it("escapes all dangerous characters", async () => {
    const { escapeHtml } = await import("../src/format");
    expect(escapeHtml('<script>alert("xss")</script>')).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });
});

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
});

describe("security page", () => {
  it("renders securityMarkdown into a page with a back link", () => {
    const html = securityPage();
    expect(html).toContain("Security Model");
    expect(html).toContain('href="/"');
  });

  it("publishes a markdown form for agents", () => {
    expect(securityMarkdown).toContain("# 41d.us — Security Model");
    expect(securityMarkdown).toContain("Layer 4 — Message encryption (E2E)");
    expect(securityMarkdown).toContain("Threat model");
  });
});
