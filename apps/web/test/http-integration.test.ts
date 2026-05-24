/**
 * Full-stack HTTP integration tests.
 *
 * These test the Hono app end-to-end: POST /invites → PUT /r/:id/participants/:pid
 * → POST /r/:id → GET /r/:id, through the real Hono router with a mocked
 * DurableObjectNamespace that creates real RendezvousSession instances.
 */
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { RendezvousSession } from "../src/rendezvous";
import { createMockState } from "./room/helpers";

/**
 * Build a mock DO namespace that creates real RendezvousSession instances
 * backed by in-memory state, keyed by room name.
 */
function mockDurableObjectNamespace(): DurableObjectNamespace {
  const sessions = new Map<string, RendezvousSession>();
  const stateStores = new Map<string, Map<string, unknown>>();

  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = id as unknown as string;
      if (!sessions.has(name)) {
        const store = new Map<string, unknown>();
        stateStores.set(name, store);
        const state = createMockState();
        // Give each session its own storage
        Object.defineProperty(state, "storage", {
          value: {
            get: async <T>(key: string) => store.get(key) as T | undefined,
            put: async <T>(key: string, value: T) => { store.set(key, value); },
            delete: async (key: string) => store.delete(key),
            deleteAll: async () => store.clear(),
            list: async () => new Map(),
            getAlarm: async () => null,
            setAlarm: async () => {},
            deleteAlarm: async () => {},
            sync: async () => {},
            transaction: async <T>(fn: () => Promise<T>) => fn(),
          },
        });
        sessions.set(name, new RendezvousSession(state, {} as any));
      }
      const stub = sessions.get(name)!;
      return {
        fetch: (input: Request | string, init?: RequestInit) => {
          const req = typeof input === "string" ? new Request(input, init) : input;
          return stub.fetch(req);
        },
        id: id,
      } as unknown as DurableObjectStub;
    },
    idFromString: () => ({} as DurableObjectId),
    newUniqueId: () => ({} as DurableObjectId),
  } as unknown as DurableObjectNamespace;
}

const env = { RENDEZVOUS: mockDurableObjectNamespace() };

describe("HTTP integration", () => {
  it("creates an invite and gets a room URL", async () => {
    const res = await app.fetch(
      new Request("https://41d.us/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          host_id: "agent-a",
          room_name: "integration-test",
          max_participants: 4,
          purpose: "Integration test room",
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.room_url).toMatch(/^https:\/\/41d\.us\/r\//);
    expect(body.join_secret).toBeDefined();
    expect(body.room.host_id).toBe("agent-a");
    expect(body.room.name).toBe("integration-test");
    expect(body.room.max_participants).toBe(4);
    expect(body.skill).toBe("https://41d.us/skill/SKILL.md");
  });

  it("joins a room, sends and reads messages", async () => {
    // Create invite
    const inviteRes = await app.fetch(
      new Request("https://41d.us/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host_id: "agent-a", room_name: "chat-room", max_participants: 4 }),
      }),
      env,
    );
    const invite = await inviteRes.json<any>();
    const { room_url: roomUrl, join_secret: joinSecret } = invite;

    // Join participant A
    const joinRes = await app.fetch(
      new Request(`${roomUrl}/participants/agent-a`, {
        method: "PUT",
        headers: { authorization: `Bearer ${joinSecret}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", skills: ["testing"] }),
      }),
      env,
    );
    expect(joinRes.status).toBe(200);
    const joinBody = await joinRes.json<any>();
    expect(joinBody.participant_id).toBe("agent-a");
    expect(joinBody.is_host).toBe(true); // host_id is "agent-a", same as joining participant

    // Join participant B
    const joinB = await app.fetch(
      new Request(`${roomUrl}/participants/agent-b`, {
        method: "PUT",
        headers: { authorization: `Bearer ${joinSecret}`, "content-type": "application/json" },
      }),
      env,
    );
    expect(joinB.status).toBe(200);

    for (const id of ["agent-a", "agent-b"]) {
      const keyRes = await app.fetch(
        new Request(roomUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${joinSecret}`,
            "x-participant-id": id,
            "content-type": "application/json",
          },
          body: JSON.stringify({ to: "all", intent: "key.exchange", body: { public_key: `${id}-raw-key` } }),
        }),
        env,
      );
      expect(keyRes.status).toBe(200);
    }

    // Send message as agent-a
    const sendRes = await app.fetch(
      new Request(roomUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${joinSecret}`,
          "x-participant-id": "agent-a",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: "all",
          body: { encrypted: true, ciphertext: "hello-cipher", iv: "hello-iv", keys: { "agent-a": { encrypted_key: "key", iv: "iv" }, "agent-b": { encrypted_key: "key", iv: "iv" } } },
          intent: "notify",
        }),
      }),
      env,
    );
    expect(sendRes.status).toBe(200);
    const sendBody = await sendRes.json<any>();
    expect(sendBody.ok).toBe(true);
    expect(sendBody.seq).toBeGreaterThan(0);

    // Read as agent-b (skip room_purpose and key exchange messages)
    const readRes = await app.fetch(
      new Request(`${roomUrl}?after=1`, {
        headers: { authorization: `Bearer ${joinSecret}`, "x-participant-id": "agent-b" },
      }),
      env,
    );
    expect(readRes.status).toBe(200);
    const readBody = await readRes.json<any>();
    const notifications = readBody.messages.filter((message: any) => message.intent === "notify");
    expect(notifications.length).toBe(1);
    expect(notifications[0].from).toBe("agent-a");
  });

  it("rejects bad auth on room operations", async () => {
    const inviteRes = await app.fetch(
      new Request("https://41d.us/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host_id: "host", room_name: "secure-room", max_participants: 4 }),
      }),
      env,
    );
    const invite = await inviteRes.json<any>();
    const { room_url: roomUrl } = invite;

    // Wrong secret
    const res = await app.fetch(
      new Request(`${roomUrl}/participants/intruder`, {
        method: "PUT",
        headers: { authorization: "Bearer wrong-secret", "content-type": "application/json" },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns room status and participant list", async () => {
    const inviteRes = await app.fetch(
      new Request("https://41d.us/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host_id: "host", room_name: "status-test", max_participants: 4 }),
      }),
      env,
    );
    const invite = await inviteRes.json<any>();
    const { room_url: roomUrl, join_secret: joinSecret } = invite;

    await app.fetch(
      new Request(`${roomUrl}/participants/agent-a`, {
        method: "PUT",
        headers: { authorization: `Bearer ${joinSecret}`, "content-type": "application/json" },
      }),
      env,
    );

    const statusRes = await app.fetch(
      new Request(`${roomUrl}/status`, {
        headers: { authorization: `Bearer ${joinSecret}` },
      }),
      env,
    );
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json<any>();
    expect(status.room.room_id).toBe(invite.room_id);
    expect(status.participants.length).toBe(1);
    expect(status.participants[0].id).toBe("agent-a");
    expect(status.closed).toBe(false);

    const partRes = await app.fetch(
      new Request(`${roomUrl}/participants`, {
        headers: { authorization: `Bearer ${joinSecret}` },
      }),
      env,
    );
    expect(partRes.status).toBe(200);
    const parts = await partRes.json<any>();
    expect(parts.participants.length).toBe(1);
  });

  it("serves the home page for browsers", async () => {
    const res = await app.fetch(
      new Request("https://41d.us/", {
        headers: { accept: "text/html", "user-agent": "Mozilla/5.0" },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!doctype html>");
    expect(text).toContain("41d.us");
  });

  it("serves markdown for agents on the home page", async () => {
    const res = await app.fetch(
      new Request("https://41d.us/", {
        headers: { accept: "text/markdown", "user-agent": "curl/8.0" },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# 41d.us");
  });

  it("serves the security page", async () => {
    const res = await app.fetch(new Request("https://41d.us/security"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Security Model");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.fetch(new Request("https://41d.us/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns invite instructions when visiting room URL without auth", async () => {
    const inviteRes = await app.fetch(
      new Request("https://41d.us/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host_id: "host", room_name: "instr-room", max_participants: 4 }),
      }),
      env,
    );
    const invite = await inviteRes.json<any>();
    const { room_url: roomUrl } = invite;

    // Visit room URL without auth headers → should get invite instructions
    const res = await app.fetch(new Request(roomUrl), env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("41d.us invite");
  });
});
