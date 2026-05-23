import { MAX_BODY_BYTES } from "../src/constants";
import { describe, expect, it } from "vitest";
import { sdkMarkdown } from "../src/client-assets";
import app from "../src/index";
import { hashJoinSecret, randomBase64Url } from "../src/crypto";
import { prefersMarkdown } from "../src/format";
import { homeMarkdown, homePage, inviteInstructionsMarkdown } from "../src/html";
import { skillMarkdown, skillPage } from "../src/skill";

describe("homePage", () => {
  it("presents the project and the end-to-end encryption promise", () => {
    const html = homePage();

    expect(html).toContain("Secure agentic collaboration space.");
    expect(html).toContain("All communication is end-to-end encrypted between agents.");
    expect(html).toContain("short-lived encrypted romantic adventure");
    expect(html).toContain("/skill");
    expect(html).toContain("/skill/SKILL.md");
    expect(html).not.toContain("/client/agent.py");
  });

  it("has markdown for agents", () => {
    const markdown = homeMarkdown();

    expect(markdown).toContain("# 41d.us");
    expect(markdown).toContain("Secure agentic collaboration space.");
    expect(markdown).toContain("All communication is end-to-end encrypted between agents.");
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
    expect(skillMarkdown).toContain("HTTP async mailbox");
    expect(skillMarkdown).toContain("https://41d.us/client/SDK.md");
    expect(skillMarkdown).not.toContain("https://41d.us/client/agent.py");
    expect(skillMarkdown).not.toContain("const invite = await createInvite");
  });
});

describe("public client assets", () => {
  it("serves SDK docs content", () => {
    expect(sdkMarkdown).toContain("async HTTP mailbox");
    expect(sdkMarkdown).not.toContain("python examples/agent.py");
  });
});

describe("invite instructions", () => {
  it("shows a direct Agent B join command", () => {
    const markdown = inviteInstructionsMarkdown("abc", "https://41d.us/r/abc", "secret");

    expect(markdown).toContain("ROOM_URL='https://41d.us/r/abc'");
    expect(markdown).toContain("JOIN_SECRET='secret'");
    expect(markdown).toContain("curl -sS -X POST \"$ROOM_URL/join\"");
    expect(markdown).toContain("Plain curl examples send plaintext JSON bodies");
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

    const response = await app.fetch(new Request("https://41d.us/invites", { method: "POST", body: JSON.stringify({ host_id: "CalmPhoenix", room_name: "review room", max_participants: 7, purpose: "Review the mailbox API." }) }), env);
    const body = (await response.json()) as { intro: string; next_step: string; room: { name: string; host_id: string; max_participants: number; purpose?: { text?: string } }; api: { status: string; close: string }; quickstart: { join: string }; host_id?: string; max_participants?: number; room_url: string; instructions?: string; readme?: string; skill: string };

    expect(body.intro).toContain("invited by CalmPhoenix");
    expect(body.room).toEqual({ name: "review room", host_id: "CalmPhoenix", max_participants: 7, purpose: { text: "Review the mailbox API." } });
    expect(body.host_id).toBeUndefined();
    expect(body.max_participants).toBeUndefined();
    expect(body.next_step).toBe("Open room_url and follow the Join now command.");
    expect(body.api.status).toMatch(/\/status$/);
    expect(body.api.close).toMatch(/\/close$/);
    expect(body.quickstart.join).toContain("curl -sS -X POST");
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
