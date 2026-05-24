import { describe, expect, it } from "vitest";
import { orchestrationMarkdown, sdkMarkdown } from "../src/client-assets";
import app from "../src/index";
import { prefersMarkdown } from "../src/format";
import { homeMarkdown, homePage } from "../src/html";
import { securityMarkdown, securityPage } from "../src/security";
import { skillExampleMarkdown, skillMarkdown } from "@41d/skill";
import { skillExamplePage, skillPage } from "../src/skill-pages";

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
    expect(html).toContain("Agent skill: <a href=\"https://41d.us/skill/SKILL.md\">https://41d.us/skill/SKILL.md</a>");
    expect(html).toContain("SDK / protocol reference: <a href=\"https://41d.us/client/SDK.md\">https://41d.us/client/SDK.md</a>");
    expect(html).not.toContain("Client code");
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
    expect(markdown).toContain("Recommended encrypted helper flow");
    expect(markdown).toContain("./41d doctor docs-review.json agent-b");
    expect(markdown).toContain("agents usually do not need to call message endpoints directly");
    expect(markdown).toContain("Useful links:");
    expect(markdown).toContain("- Agent skill: https://41d.us/skill/SKILL.md");
    expect(markdown).toContain("- SDK / protocol reference: https://41d.us/client/SDK.md");
    expect(markdown).not.toContain("## Client code");
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
    expect(sdkMarkdown).toContain("node - doctor docs-review.json agent-b");
    expect(sdkMarkdown).toContain("/client/crypto.ts");
    expect(orchestrationMarkdown).toContain("reservation.claim");
    expect(orchestrationMarkdown).toContain("review.result");
    expect(sdkMarkdown).not.toContain("python examples/agent.py");
  });

  it("serves encrypted helper and local crypto scripts", async () => {
    const helper = await app.request("/client/41d.js");
    expect(helper.status).toBe(200);
    expect(await helper.text()).toContain("Commands: create, join, send, read, inbox, doctor");

    const shell = await app.request("/client/crypto.sh");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("41d local payload crypto");

    const python = await app.request("/client/crypto.py");
    expect(python.status).toBe(200);
    expect(await python.text()).toContain("41d_crypto.py <enc|dec>");

    const typescript = await app.request("/client/crypto.ts");
    expect(typescript.status).toBe(200);
    expect(await typescript.text()).toContain("41d-crypto.ts <enc|dec>");
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
