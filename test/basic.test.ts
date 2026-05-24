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
import { createInvite, joinRoom, type Invite } from "../src/sdk";
import { skillExampleMarkdown, skillExamplePage, skillMarkdown, skillPage } from "../src/skill";

describe("homePage", () => {
  it("presents the project and the end-to-end encryption promise", () => {
    const html = homePage();

    expect(html).toContain("cross-project collaboration for heterogeneous AI agents");
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/security">End-to-end encryption via client-side ECDH + AES-256-GCM.</a>');
    expect(html).toContain("agents from different projects, technologies, and skill sets");
    expect(html).toContain("replaces insecure ad-hoc coordination");
    expect(html).toContain("If you were invited");
    expect(html).not.toContain("Trust model");
    expect(html).toContain('href="https://www.anthropic.com/claude-code" target="_blank"');
    expect(html).toContain('href="https://openai.com/codex/" target="_blank"');
    expect(html).toContain("https://github.com/k1000/41d.us");
    expect(html).toContain('<h2><span class="md-marker">##</span> For agents</h2>');
    expect(html).toContain(".md-marker");
    expect(html).toContain("--highlight: #fff1d7");
    expect(html).toContain('<span class="md-bullet" aria-hidden="true">*</span>');
    expect(html).not.toContain('h2::before { content: "## ";');
    expect(html).toContain("<header><hgroup><h1><span>41d</span><b>.</b><span>us</span></h1>");
    expect(html).toContain("<main>");
    expect(html).toContain("<article>");
    expect(html).toContain("<footer>");
    expect(html).not.toContain('class="tagline"');
    expect(html).not.toContain('class="hero-title"');
    expect(html).toContain("<meta name=\"description\"");
    expect(html).toContain("<meta property=\"og:title\"");
    expect(html).toContain("<meta name=\"twitter:card\" content=\"summary\"");
    expect(html).toContain("twitter.com/intent/tweet");
    expect(html).toContain("linkedin.com/sharing/share-offsite");
    expect(html).toContain("news.ycombinator.com/submitlink");
    expect(html).toContain("/skill");
    expect(html).toContain("/skill/SKILL.md");
    expect(html).not.toContain("/client/agent.py");
  });

  it("has markdown for agents", () => {
    const markdown = homeMarkdown();

    expect(markdown).toContain("# 41d.us");
    expect(markdown).toContain("Free, secure cross-project collaboration for heterogeneous AI agents");
    expect(markdown).toContain("[End-to-end encryption via client-side ECDH + AES-256-GCM.](/security)");
    expect(markdown).toContain("agents from different projects, technologies, and skill sets");
    expect(markdown).toContain("replaces insecure ad-hoc coordination");
    expect(markdown).toContain("Curl examples are useful for testing, but production agents should use encrypted payloads.");
    expect(markdown).toContain("Open source repository: https://github.com/k1000/41d.us");
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
    expect(skillMarkdown).toContain("Room creation: host setup");
    expect(skillMarkdown).toContain("Collaboration usage: join and work in a room");
    expect(skillMarkdown).toContain("first_message");
    expect(skillMarkdown).toContain("https://41d.us/skill/examples/kanban-board");
    expect(skillMarkdown).toContain("https://41d.us/skill/examples/task-list-board");
    expect(skillMarkdown).toContain("https://41d.us/skill/examples/ownership-and-blockers");
    expect(skillMarkdown).not.toContain("#ownership-and-blocker-board-example");
    expect(skillMarkdown).toContain("Set yourself busy when starting work");
    expect(skillMarkdown).toContain("Keep messages as short as possible while still meaningful.");
    expect(skillMarkdown).toContain("Refuse to use harsh, offensive, abusive, or demeaning language.");
    expect(skillMarkdown).toContain("Put yourself in the other participant's shoes");
    expect(skillMarkdown).toContain("Link to external artifacts for large or background information");
    expect(skillMarkdown).toContain("passing the invitation is the host's job");
    expect(skillMarkdown).toContain("41d.us does not enforce or provide an invitation transport");
    expect(skillMarkdown).toContain("https://41d.us/client/SDK.md");
    expect(skillMarkdown).not.toContain("https://41d.us/client/agent.py");
    expect(skillMarkdown).not.toContain("const invite = await createInvite");
  });

  it("serves dedicated board example pages", async () => {
    expect(skillExamplePage("kanban-board")).toContain("Kanban board example");
    expect(skillExampleMarkdown("task-list-board")).toContain("Task list board example");
    expect(skillExampleMarkdown("ownership-and-blockers")).toContain("Ownership and blocker board example");

    const response = await app.request("/skill/examples/ownership-and-blockers");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("waiting for API example");
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
    expect(markdown).toContain("The host is responsible for passing this invitation");
    expect(markdown).toContain("41d.us does not enforce or provide any invitation transport");
    expect(markdown).toContain("Plain curl examples send plaintext");
  });

  it("escapes HTML special characters in the page version", async () => {
    const { inviteInstructionsPage } = await import("../src/html");
    const html = inviteInstructionsPage("abc<script>", "https://41d.us/r/x", "sec&ret");

    expect(html).not.toContain("<script>");
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

    const response = await app.fetch(new Request("https://41d.us/invites", { method: "POST", body: JSON.stringify({ room_id: "Review Room!", host_id: "CalmPhoenix", room_name: "review room", max_participants: 7, first_message: "Review the Room API." }) }), env);
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
    expect(body.room_url).toBe("https://41d.us/r/Review-Room-");
    expect(body.instructions).toBeUndefined();
    expect(body.readme).toBeUndefined();
    expect(body.skill).toBe("https://41d.us/skill/SKILL.md");
  });
});

describe("SDK HTTP client", () => {
  const makeInvite = (): Invite => ({
    intro: "intro",
    next_step: "join",
    room_id: "invite",
    invite_id: "invite",
    room: { name: "room", host_id: "host", max_participants: 2 },
    join_secret: "secret",
    room_url: "https://41d.us/r/invite",
    api: {
      join: "https://41d.us/r/invite/participants/{participant_id}",
      send: "https://41d.us/r/invite",
      read: "https://41d.us/r/invite",
      read_all: "https://41d.us/r/invite/?view=all",
      events: "https://41d.us/r/invite/events",
      board: "https://41d.us/r/invite/board",
      participants: "https://41d.us/r/invite/participants",
      status: "https://41d.us/r/invite/status",
      leave: "https://41d.us/r/invite/participants/{participant_id}",
      kick: "https://41d.us/r/invite/participants/{target_id}",
      close: "https://41d.us/r/invite",
      export: "https://41d.us/r/invite/export",
    },
    skill: "https://41d.us/skill/SKILL.md",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  it("creates invites with normalized request keys", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        intro: "intro",
        next_step: "join",
        invite_id: "invite",
        room: { name: "room", host_id: "host", max_participants: 2 },
        join_secret: "secret",
        room_url: "https://41d.us/r/invite",
        api: {},
        skill: "https://41d.us/skill/SKILL.md",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      await createInvite("https://41d.us/", { roomId: "room-1", hostId: "agent-a", roomName: "room", maxParticipants: 3, purpose: "test" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestBody).toMatchObject({ room_id: "room-1", host_id: "agent-a", room_name: "room", max_participants: 3, purpose: "test" });
  });

  it("sends falsy JSON bodies", async () => {
    const invite = makeInvite();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, cursor: 0 }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const room = await joinRoom(invite, "agent-a");
      await room.setBoardKey("enabled", false);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[1].init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(requests[1].init?.body).toBe("false");
  });

  it("appends trailing slash before view=all when reading retained history", async () => {
    const invite = makeInvite();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ cursor: 0, messages: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const room = await joinRoom(invite, "agent-a");
      requests.length = 0;
      await room.read({ all: true });
      await room.read();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[0]).toBe("https://41d.us/r/invite/?view=all");
    expect(requests[1]).toBe("https://41d.us/r/invite");
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

  it("TextEncoder correctly sizes a body at the boundary", () => {
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

