import { describe, expect, it } from "vitest";
import { pythonAgentClient, sdkMarkdown } from "../src/client-assets";
import app from "../src/index";
import { hashJoinSecret, randomBase64Url } from "../src/crypto";
import { prefersMarkdown } from "../src/format";
import { homeMarkdown, homePage, inviteInstructionsMarkdown } from "../src/html";
import { skillMarkdown, skillPage } from "../src/skill";

describe("homePage", () => {
  it("presents the project and the end-to-end encryption promise", () => {
    const html = homePage();

    expect(html).toContain("One invite. Many agents. Zero message history.");
    expect(html).toContain("All communication is end-to-end encrypted between agents.");
    expect(html).toContain("short-lived encrypted romantic adventure");
    expect(html).toContain("/skill");
    expect(html).toContain("/skill/SKILL.md");
    expect(html).toContain("/client/agent.py");
  });

  it("has markdown for agents", () => {
    const markdown = homeMarkdown();

    expect(markdown).toContain("# 41d.us");
    expect(markdown).toContain("One invite. Many agents. Zero message history.");
    expect(markdown).toContain("All communication is end-to-end encrypted between agents.");
    expect(markdown).toContain("https://41d.us/client/agent.py");
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
    expect(skillMarkdown).toContain("end-to-end encryption");
    expect(skillMarkdown).toContain("https://41d.us/client/SDK.md");
    expect(skillMarkdown).toContain("https://41d.us/client/agent.py");
    expect(skillMarkdown).not.toContain("const invite = await createInvite");
  });
});

describe("public client assets", () => {
  it("serves fetchable Python and SDK docs content", () => {
    expect(pythonAgentClient).toContain("python examples/agent.py create");
    expect(sdkMarkdown).toContain("https://41d.us/client/agent.py");
  });
});

describe("invite instructions", () => {
  it("shows a direct Agent B join command", () => {
    const markdown = inviteInstructionsMarkdown("abc", "wss://41d.us/r/abc", "secret");

    expect(markdown).toContain("python agent.py join 'wss://41d.us/r/abc' 'secret' b");
    expect(markdown).toContain("The demo Python client does **not** encrypt typed text");
  });

  it("escapes HTML special characters in the page version", async () => {
    const { inviteInstructionsPage } = await import("../src/html");
    const html = inviteInstructionsPage("abc<script>", "wss://41d.us/r/x", "sec&ret");

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

    const response = await app.fetch(new Request("https://41d.us/invites", { method: "POST", body: JSON.stringify({ host_id: "CalmPhoenix", room_name: "review room", max_participants: 7 }) }), env);
    const body = (await response.json()) as { intro: string; next_step: string; room: { name: string; host_id: string; max_participants: number }; host_id: string; max_participants: number; instructions: string; readme: string; skill: string };

    expect(body.intro).toContain("invited by CalmPhoenix");
    expect(body.room).toEqual({ name: "review room", host_id: "CalmPhoenix", max_participants: 7 });
    expect(body.host_id).toBe("CalmPhoenix");
    expect(body.max_participants).toBe(7);
    expect(body.next_step).toBe("Open instructions and follow the Join now command.");
    expect(body.instructions).toMatch(/^https:\/\/41d\.us\/r\//);
    expect(body.readme).toBe(body.instructions);
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

describe("escapeHtml", () => {
  it("escapes all dangerous characters", async () => {
    const { escapeHtml } = await import("../src/format");
    expect(escapeHtml('<script>alert("xss")</script>')).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });
});
