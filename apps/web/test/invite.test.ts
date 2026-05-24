import { describe, expect, it } from "vitest";
import app from "../src/index";
import { hashJoinSecret, randomBase64Url } from "@41d/sdk/crypto";
import { INVITE_TTL_MS, MAX_INVITE_TTL_MS, MIN_INVITE_TTL_MS } from "../src/constants";
import { inviteInstructionsMarkdown } from "../src/html";

describe("invite instructions", () => {
  it("shows a direct Agent B join command", () => {
    const markdown = inviteInstructionsMarkdown("https://41d.us/r/abc", "secret");

    expect(markdown).toContain("ROOM_URL='https://41d.us/r/abc'");
    expect(markdown).toContain("JOIN_SECRET='secret'");
    expect(markdown).toContain("node - join \"$ROOM_URL\" \"$JOIN_SECRET\" \"$ME\"");
    expect(markdown).toContain("The host should deliver the room URL and join secret through a channel they control and trust");
    expect(markdown).toContain("41d.us has no mechanism to verify the identity of invitees");
    expect(markdown).toContain("The encrypted helper announces your ECDH public key on join");
  });

  it("escapes HTML special characters in the page version", async () => {
    const { inviteInstructionsPage } = await import("../src/html");
    const html = inviteInstructionsPage("https://41d.us/r/x", "sec&ret");

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
    const body = (await response.json()) as {
      intro: string; next_step: string; room_id: string; invite_id?: string;
      room: { name: string; host_id: string; max_participants: number; purpose?: { text?: string } };
      api: { events: string; status: string; close: string };
      quickstart: Record<string, string>;
      host_id?: string; max_participants?: number; room_url: string;
      instructions?: string; readme?: string; skill: string;
    };

    expect(body.intro).toContain("invited by CalmPhoenix");
    expect(body.room).toEqual({ name: "review room", host_id: "CalmPhoenix", max_participants: 7, purpose: { text: "Review the Room API." } });
    expect(body.room_id).toBe("Review-Room-");
    expect(body.invite_id).toBeUndefined();
    expect(body.host_id).toBeUndefined();
    expect(body.max_participants).toBeUndefined();
    expect(body.next_step).toContain("quickstart.join");
    expect(body.api.events).toMatch(/\/events$/);
    expect(body.api.status).toMatch(/\/status$/);
    expect(body.api.close).toBe(body.room_url);
    expect(body.quickstart.join).toContain("node - join");
    expect(body.quickstart.join_diagnostic_only).toContain("curl -sS -X PUT");
    expect(body.quickstart.events).toContain("curl -N");
    expect(body.quickstart.create_room_file).toContain("node - create 'https://41d.us'");
    expect(body.quickstart.create_room_file).toContain("> review-room.json");
    expect(body.quickstart.send_encrypted).toContain("https://41d.us/client/41d.js");
    expect(body.quickstart.send_local_encrypted_payload).toContain("https://41d.us/client/crypto.sh");
    expect(body.room_url).toBe("https://41d.us/r/Review-Room-");
    expect(body.instructions).toBeUndefined();
    expect(body.readme).toBeUndefined();
    expect(body.skill).toBe("https://41d.us/skill/SKILL.md");
  });
});

describe("invite TTL", () => {
  async function postInvite(body: Record<string, unknown>): Promise<{ initBody: { expiresAt: number }; inviteExpiresAt: string }> {
    const captured: { body?: string } = {};
    const env = {
      RENDEZVOUS: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (_url: string, init?: RequestInit) => {
            if (init?.body) captured.body = init.body as string;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        }),
      },
    };
    const response = await app.fetch(
      new Request("https://41d.us/invites", { method: "POST", body: JSON.stringify(body) }),
      env,
    );
    const inviteJson = (await response.json()) as { expires_at: string };
    return { initBody: JSON.parse(captured.body ?? "{}"), inviteExpiresAt: inviteJson.expires_at };
  }

  function expectExpiresNear(actual: number, expected: number) {
    expect(actual).toBeGreaterThanOrEqual(expected - 1000);
    expect(actual).toBeLessThanOrEqual(expected + 1000);
  }

  it("uses the default TTL when invite_ttl_ms is omitted", async () => {
    const before = Date.now();
    const { initBody } = await postInvite({ host_id: "h" });
    expectExpiresNear(initBody.expiresAt, before + INVITE_TTL_MS);
  });

  it("respects a custom invite_ttl_ms within bounds", async () => {
    const before = Date.now();
    const custom = 15 * 60 * 1000;
    const { initBody } = await postInvite({ host_id: "h", invite_ttl_ms: custom });
    expectExpiresNear(initBody.expiresAt, before + custom);
  });

  it("clamps invite_ttl_ms below the minimum", async () => {
    const before = Date.now();
    const { initBody } = await postInvite({ host_id: "h", invite_ttl_ms: 1000 });
    expectExpiresNear(initBody.expiresAt, before + MIN_INVITE_TTL_MS);
  });

  it("clamps invite_ttl_ms above the maximum", async () => {
    const before = Date.now();
    const { initBody } = await postInvite({ host_id: "h", invite_ttl_ms: 99 * MAX_INVITE_TTL_MS });
    expectExpiresNear(initBody.expiresAt, before + MAX_INVITE_TTL_MS);
  });

  it("falls back to the default for non-finite invite_ttl_ms values", async () => {
    const before = Date.now();
    const { initBody } = await postInvite({ host_id: "h", invite_ttl_ms: "five minutes" });
    expectExpiresNear(initBody.expiresAt, before + INVITE_TTL_MS);
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
