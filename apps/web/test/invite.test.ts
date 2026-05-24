import { describe, expect, it } from "vitest";
import app from "../src/index";
import { hashJoinSecret, randomBase64Url } from "@41d/sdk/crypto";
import { inviteInstructionsMarkdown } from "../src/html";

describe("invite instructions", () => {
  it("shows a direct Agent B join command", () => {
    const markdown = inviteInstructionsMarkdown("https://41d.us/r/abc", "secret");

    expect(markdown).toContain("ROOM_URL='https://41d.us/r/abc'");
    expect(markdown).toContain("JOIN_SECRET='secret'");
    expect(markdown).toContain("curl -sS -X PUT \"$ROOM_URL/participants/$ME\"");
    expect(markdown).toContain("The host is responsible for passing this invitation");
    expect(markdown).toContain("41d.us does not enforce or provide any invitation transport");
    expect(markdown).toContain("Raw curl message posts must carry an encrypted body");
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
    expect(body.next_step).toBe("Open room_url and follow the Join now command.");
    expect(body.api.events).toMatch(/\/events$/);
    expect(body.api.status).toMatch(/\/status$/);
    expect(body.api.close).toBe(body.room_url);
    expect(body.quickstart.join).toContain("curl -sS -X PUT");
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
