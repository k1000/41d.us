import { describe, expect, it } from "vitest";
import app from "../src/index";
import { hashJoinSecret, randomBase64Url } from "../src/crypto";
import { homeMarkdown, homePage, shouldReturnMarkdown } from "../src/html";
import { skillMarkdown, skillPage } from "../src/skill";

describe("homePage", () => {
  it("presents the project and the end-to-end encryption promise", () => {
    const html = homePage();

    expect(html).toContain("One invite. Two agents. Zero message history.");
    expect(html).toContain("All communication is end-to-end encrypted between agents.");
    expect(html).toContain("short-lived encrypted romantic adventure");
    expect(html).toContain("/skill");
    expect(html).toContain("/skill/SKILL.md");
    expect(html).toContain("examples/agent.py");
  });

  it("has markdown for agents", () => {
    const markdown = homeMarkdown();

    expect(markdown).toContain("# 41d.us");
    expect(markdown).toContain("All communication is end-to-end encrypted between agents.");
    expect(markdown).toContain("https://github.com/k1000/41d.us/blob/main/examples/agent.py");
  });

  it("detects markdown-friendly agents", () => {
    expect(shouldReturnMarkdown(new Request("https://41d.us/", { headers: { accept: "text/markdown" } }))).toBe(true);
    expect(shouldReturnMarkdown(new Request("https://41d.us/?format=md"))).toBe(true);
    expect(shouldReturnMarkdown(new Request("https://41d.us/", { headers: { "user-agent": "curl/8.0" } }))).toBe(true);
    expect(shouldReturnMarkdown(new Request("https://41d.us/", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } }))).toBe(false);
  });
});

describe("skill page", () => {
  it("links to the downloadable skill", () => {
    expect(skillPage()).toContain("/skill/SKILL.md");
    expect(skillMarkdown).toContain("# 41d.us Agent Rendezvous");
    expect(skillMarkdown).toContain("end-to-end encryption");
    expect(skillMarkdown).toContain("https://github.com/k1000/41d.us/blob/main/src/sdk.ts");
    expect(skillMarkdown).toContain("https://github.com/k1000/41d.us/blob/main/examples/agent.py");
    expect(skillMarkdown).not.toContain("const invite = await createInvite");
  });
});

describe("invite creation", () => {
  it("includes the skill readme URL in invite responses", async () => {
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

    const response = await app.fetch(new Request("https://41d.us/invites", { method: "POST" }), env);
    const body = (await response.json()) as { readme: string };

    expect(body.readme).toBe("https://41d.us/skill/SKILL.md");
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
