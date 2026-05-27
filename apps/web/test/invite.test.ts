import { describe, expect, it } from "vitest";
import app from "../src/index";
import { hashJoinSecret, randomBase64Url } from "@j01n/sdk/crypto";
import { INVITE_TTL_MS, MAX_INVITE_TTL_MS, MIN_INVITE_TTL_MS } from "../src/constants";
import { inviteInstructionsMarkdown } from "../src/html";
import { encryptedPayload } from "./room/helpers";

describe("invite instructions", () => {
  it("shows a direct Agent B join command", () => {
    const markdown = inviteInstructionsMarkdown("https://j01n.me/r/abc", "secret");

    expect(markdown).toContain("ACCESS='https://j01n.me/r/abc'");
    expect(markdown).toContain("JOIN_SECRET='secret'");
    expect(markdown).toContain("node .j01n/j01n.js join invitation.json '<your_unique_name>' > participant.j01n.json");
    expect(markdown).toContain("node .j01n/j01n.js watch participant.j01n.json");
    expect(markdown).toContain("After join, immediately watch the room or poll `read`");
    expect(markdown).toContain("https://j01n.me/client/CLAUDE_CODE.md");
    expect(markdown).toContain("The join secret is not shown on this page");
    expect(markdown).toContain("Choose your agent or harness");
    expect(markdown).toContain("https://j01n.me/client/PI.md");
    expect(markdown).toContain("https://j01n.me/client/MCP.md");
  });

  it("escapes HTML special characters in the page version", async () => {
    const { inviteInstructionsPage } = await import("../src/html");
    const html = inviteInstructionsPage("https://j01n.me/r/x", "sec&ret");

    expect(html).toContain("sec&amp;ret");
  });

  it("shows the first message in room instructions when participants enter the room", () => {
    const markdown = inviteInstructionsMarkdown("https://j01n.me/r/abc", undefined, {
      name: "review",
      purpose: "docs",
      first_message: "Claim a task before editing.",
      host_id: "human",
      participant_count: 0,
      expires_at: "2026-05-26T00:00:00.000Z",
    });

    expect(markdown).toContain("- **First message**: Claim a task before editing.");
  });
});

describe("room creation", () => {
  it("returns a room access handoff with room metadata", async () => {
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

    const encrypted = encryptedPayload({ text: "Review the Room API." });
    const response = await app.fetch(new Request("https://j01n.me/rooms", { method: "POST", body: JSON.stringify({ room_id: "Review Room!", host_id: "CalmPhoenix", room_name: "review room", max_participants: 7, first_message: encrypted }) }), env);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.access).toBe("https://j01n.me/r/Review-Room-");
    expect(body.join_secret).toEqual(expect.any(String));
    expect(body.join_secret).toMatch(/^[A-Za-z0-9_-]+$/);
    // Room metadata included in the handoff.
    expect(body.room_name).toBe("review room");
    expect(body.purpose).toBe("review room");
    expect(body.host_id).toBe("CalmPhoenix");
    expect(body.expires_at).toEqual(expect.any(String));
    expect(body.host_joined).toBe(false);
    expect(body.api).toBeUndefined();
    expect(JSON.parse(String(state.get("body")))).toMatchObject({
      purpose: "review room",
      firstMessage: encrypted,
    });
  });

  it("registers created rooms for periodic stale-room cleanup", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const env = {
      RENDEZVOUS: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) }),
      },
      ROOM_REGISTRY: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            calls.push({ url, body: init?.body as string | undefined });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        }),
      },
    };

    const response = await app.fetch(new Request("https://j01n.me/rooms", { method: "POST", body: JSON.stringify({ host_id: "h", room_name: "cleanup" }) }), env);

    expect(response.status).toBe(200);
    expect(calls[0].url).toBe("https://room-registry.internal/register");
    expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({ room_id: expect.any(String), expires_at: expect.any(Number) });
  });
});

async function postRoom(body: Record<string, unknown>, path = "/rooms"): Promise<{ initBody: Record<string, any>; response: Record<string, any> }> {
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
  const response = await app.fetch(new Request(`https://j01n.me${path}`, { method: "POST", body: JSON.stringify(body) }), env);
  return { initBody: JSON.parse(captured.body ?? "{}"), response: await response.json() };
}

describe("purpose vs first_message separation", () => {
  it("stores purpose and first_message as independent fields", async () => {
    const { initBody, response } = await postRoom({
      host_id: "h",
      room_name: "review room",
      purpose: "Public: docs review",
      first_message: encryptedPayload({ text: "Internal kickoff", workflow: "claim a task" }),
    });

    expect(initBody.purpose).toBe("Public: docs review");
    expect(initBody.firstMessage).toEqual(encryptedPayload({ text: "Internal kickoff", workflow: "claim a task" }));
    expect(response.access).toMatch(/^https:\/\/j01n\.me\/r\//);
  });

  it("stores an entry message for the room page without returning it in the invitation", async () => {
    const { initBody, response } = await postRoom({
      host_id: "h",
      room_name: "review room",
      entry_message: "Claim a task before editing.",
    });

    expect(initBody.entryMessage).toBe("Claim a task before editing.");
    expect(response.first_message).toBeUndefined();
  });

  it("defaults purpose to roomName when omitted, blank, or whitespace", async () => {
    for (const purposeValue of [undefined, "", "   "]) {
      const body: Record<string, unknown> = { host_id: "h", room_name: "fallback room" };
      if (purposeValue !== undefined) body.purpose = purposeValue;
      const { initBody, response } = await postRoom(body);
      expect(initBody.purpose).toBe("fallback room");
      expect(response.access).toMatch(/^https:\/\/j01n\.me\/r\//);
    }
  });

  it("does not synthesize a plaintext first_message when first_message is omitted", async () => {
    const { initBody } = await postRoom({ host_id: "h", room_name: "n", purpose: "Audit the SDK" });
    expect(initBody.firstMessage).toBeUndefined();
  });

  it("rejects plaintext first_message", async () => {
    const env = {
      RENDEZVOUS: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) }),
      },
    };
    const response = await app.fetch(new Request("https://j01n.me/rooms", { method: "POST", body: JSON.stringify({ host_id: "h", first_message: { text: "plaintext" } }) }), env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "first_message must be encrypted" });
  });

  it("accepts POST /invites as a backward-compat alias for /rooms", async () => {
    const { initBody, response } = await postRoom(
      { host_id: "h", room_name: "legacy", purpose: "Legacy entry" },
      "/invites",
    );
    expect(initBody.purpose).toBe("Legacy entry");
    expect(response.access).toMatch(/^https:\/\/j01n\.me\/r\//);
  });
});

describe("template board wrapping", () => {
  it("wraps kanban template board defaults as opaque ui: envelopes so they satisfy encryption checks", async () => {
    const { initBody } = await postRoom({ host_id: "h", template: "kanban" });
    const board = initBody.initialBoard as Record<string, { encrypted_payload: string }>;
    expect(board.columns.encrypted_payload).toMatch(/^ui:/);
    expect(board.tasks.encrypted_payload).toMatch(/^ui:/);
  });

  it("lets user-supplied board values override template defaults", async () => {
    const userValue = encryptedPayload({ todo: ["task-1"] });
    const { initBody } = await postRoom({ host_id: "h", template: "kanban", board: { columns: userValue } });
    expect(initBody.initialBoard.columns).toEqual(userValue);
  });
});

describe("invitation TTL", () => {
  function expectExpiresNear(actual: number, expected: number) {
    expect(actual).toBeGreaterThanOrEqual(expected - 1000);
    expect(actual).toBeLessThanOrEqual(expected + 1000);
  }

  it("uses the default TTL when invite_ttl_ms is omitted", async () => {
    const before = Date.now();
    const { initBody } = await postRoom({ host_id: "h" });
    expectExpiresNear(initBody.expiresAt, before + INVITE_TTL_MS);
  });

  it("respects a custom invite_ttl_ms within bounds", async () => {
    const before = Date.now();
    const custom = 15 * 60 * 1000;
    const { initBody } = await postRoom({ host_id: "h", invite_ttl_ms: custom });
    expectExpiresNear(initBody.expiresAt, before + custom);
  });

  it("clamps invite_ttl_ms below the minimum", async () => {
    const before = Date.now();
    const { initBody } = await postRoom({ host_id: "h", invite_ttl_ms: 1000 });
    expectExpiresNear(initBody.expiresAt, before + MIN_INVITE_TTL_MS);
  });

  it("clamps invite_ttl_ms above the maximum", async () => {
    const before = Date.now();
    const { initBody } = await postRoom({ host_id: "h", invite_ttl_ms: 99 * MAX_INVITE_TTL_MS });
    expectExpiresNear(initBody.expiresAt, before + MAX_INVITE_TTL_MS);
  });

  it("falls back to the default for non-finite invite_ttl_ms values", async () => {
    const before = Date.now();
    const { initBody } = await postRoom({ host_id: "h", invite_ttl_ms: "five minutes" });
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
