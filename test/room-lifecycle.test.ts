import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_PARTICIPANTS, MAX_BODY_BYTES, MAX_BOARD_VALUE_BYTES } from "../src/constants";
import { hashJoinSecret, randomBase64Url } from "../src/crypto";
import { RendezvousSession } from "../src/rendezvous";
import type { RoomMessage } from "../src/types";

/**
 * Room lifecycle integration tests.
 *
 * These exercise the RendezvousSession DO class directly with a mocked
 * DurableObjectState backed by an in-memory Map. The request flow mirrors
 * the real Hono router: POST /__init to bootstrap, then HTTP requests
 * to the proper room paths.
 */

const INVITE_TTL_MS = 10 * 60 * 1000;

/** Create a mock DurableObjectState with in-memory storage. */
function createMockState(): DurableObjectState {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { storage.set(key, value); },
      delete: async (key: string) => storage.delete(key),
      deleteAll: async () => storage.clear(),
      list: async () => new Map(),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      sync: async () => {},
      transaction: async <T>(fn: () => Promise<T>) => fn(),
    },
    id: { toString: () => "test-do" },
    waitUntil: async () => {},
    blockConcurrencyWhile: async () => {},
  } as unknown as DurableObjectState;
}

function createMockEnv(): { RENDEZVOUS: DurableObjectNamespace } {
  return { RENDEZVOUS: {} as DurableObjectNamespace };
}

interface RoomOpts {
  roomId?: string;
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
  firstMessage?: Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  initialBoard?: Record<string, unknown>;
}

/** Bootstrap a room. Returns the session, the invite/secret, and the room path for making auth'd requests. */
async function bootstrapRoom(opts: RoomOpts = {}): Promise<RoomFixture> {
  const session = new RendezvousSession(createMockState(), createMockEnv());
  const roomId = opts.roomId ?? randomBase64Url(16);
  const joinSecret = randomBase64Url(32);
  const secretHash = await hashJoinSecret(roomId, joinSecret);

  const res = await session.fetch(new Request("https://rendezvous.internal/__init", {
    method: "POST",
    body: JSON.stringify({
      roomId,
      secretHash,
      expiresAt: Date.now() + INVITE_TTL_MS,
      phase: "waiting" as const,
      hostId: opts.hostId ?? "host",
      roomName: opts.roomName ?? "test room",
      maxParticipants: opts.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
      ...(opts.firstMessage ? { firstMessage: opts.firstMessage } : {}),
      ...(opts.boardSchema ? { boardSchema: opts.boardSchema } : {}),
      ...(opts.initialBoard ? { initialBoard: opts.initialBoard } : {}),
    }),
    headers: { "content-type": "application/json" },
  }));

  if (!res.ok) throw new Error(`bootstrapRoom failed: ${res.status}`);
  return { session, roomId, joinSecret, roomPath: `/r/${roomId}` };
}

/** Get invite state and join secret from a bootstrapped room so tests can make auth'd requests. */
interface RoomFixture {
  session: RendezvousSession;
  roomId: string;
  joinSecret: string;
  roomPath: string;
}

function authHeaders(secret: string, participantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (participantId) headers["x-participant-id"] = participantId;
  return headers;
}

async function roomRequest(fixture: RoomFixture, path = "", init?: RequestInit): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}${path}`, init));
}

async function deleteParticipant(fixture: RoomFixture, targetId: string, actorId?: string): Promise<Response> {
  return roomRequest(fixture, `/participants/${encodeURIComponent(targetId)}`, {
    method: "DELETE",
    headers: authHeaders(fixture.joinSecret, actorId),
  });
}

async function closeRoom(fixture: RoomFixture): Promise<Response> {
  return roomRequest(fixture, "", {
    method: "DELETE",
    headers: authHeaders(fixture.joinSecret, "host"),
  });
}

async function getRoomJson<T>(fixture: RoomFixture, path: string): Promise<T> {
  const res = await roomRequest(fixture, path, { headers: authHeaders(fixture.joinSecret) });
  expect(res.status).toBe(200);
  return await res.json() as T;
}

async function joinParticipant(fixture: RoomFixture, participantId: string): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}/participants/${encodeURIComponent(participantId)}`, {
    method: "PUT",
    headers: { ...authHeaders(fixture.joinSecret), "content-type": "application/json" },
  }));
}

function encryptedPayload(body: unknown): { encrypted_payload: string } {
  return { encrypted_payload: JSON.stringify(body) };
}

function decodedPayload<T>(body: unknown): T {
  return JSON.parse((body as { encrypted_payload: string }).encrypted_payload) as T;
}

async function sendMessage(fixture: RoomFixture, participantId: string, to: string, body: unknown): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}`, {
    method: "POST",
    headers: { ...authHeaders(fixture.joinSecret, participantId), "content-type": "application/json" },
    body: JSON.stringify({ to, body: encryptedPayload(body) }),
  }));
}

async function readMessages(fixture: RoomFixture, participantId: string, after = 0): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}?after=${after}`, {
    headers: authHeaders(fixture.joinSecret, participantId),
  }));
}

describe("room lifecycle", () => {
  let fix: RoomFixture;

  beforeEach(async () => {
    fix = await bootstrapRoom();
  });

  it("bootstraps a room via __init (verified by bootstrapRoom)", async () => {
    // bootstrapRoom already calls init and verifies success.
    // Verify the room is usable by joining.
    const res = await joinParticipant(fix, "check");
    expect(res.status).toBe(200);
  });

  it("rejects duplicate __init", async () => {
    const res = await fix.session.fetch(new Request("https://rendezvous.internal/__init", {
      method: "POST",
      body: JSON.stringify({
        roomId: fix.roomId,
        secretHash: await hashJoinSecret(fix.roomId, "unused"),
        expiresAt: Date.now() + INVITE_TTL_MS,
        phase: "waiting" as const,
        hostId: "host",
      }),
      headers: { "content-type": "application/json" },
    }));
    expect(res.status).toBe(409);
  });

  it("allows a participant to join", async () => {
    const res = await joinParticipant(fix, "agent-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; participant_id: string };
    expect(body.ok).toBe(true);
    expect(body.participant_id).toBe("agent-a");
  });

  it("rejects wrong join secret", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/participants/agent-x`, {
      method: "PUT",
      headers: { ...authHeaders("wrong-secret"), "content-type": "application/json" },
    }));
    expect(res.status).toBe(403);
  });

  it("rejects duplicate participant ID", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await joinParticipant(fix, "agent-a");
    expect(res.status).toBe(409);
  });

  it("enforces max_participants", async () => {
    const smallFix = await bootstrapRoom({ maxParticipants: 2 });
    await joinParticipant(smallFix, "agent-a");
    await joinParticipant(smallFix, "agent-b");
    const res = await joinParticipant(smallFix, "agent-c");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("room is full");
  });

  it("allows send and read between participants", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");

    await sendMessage(fix, "agent-a", "all", { text: "hello from a" });
    await sendMessage(fix, "agent-b", "all", { text: "hello from b" });

    const res = await readMessages(fix, "agent-a", 1); // skip first message (room_purpose)
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: RoomMessage[] };
    const fromOthers = body.messages.filter((m) => m.from !== "agent-a");
    expect(fromOthers.length).toBeGreaterThanOrEqual(1);
    expect(fromOthers.some((m) => decodedPayload<{ text: string }>(m.body).text === "hello from b")).toBe(true);
  });

  it("delivers direct messages only to the named recipient", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await joinParticipant(fix, "agent-c");

    await sendMessage(fix, "agent-a", "agent-b", { secret: "for b only" });

    const resB = await readMessages(fix, "agent-b");
    const resC = await readMessages(fix, "agent-c");

    const bBody = (await resB.json()) as { messages: RoomMessage[] };
    const cBody = (await resC.json()) as { messages: RoomMessage[] };

    const bGot = bBody.messages.some((m) => m.from === "agent-a" && decodedPayload<{ secret: string }>(m.body).secret === "for b only");
    const cGot = cBody.messages.some((m) => m.from === "agent-a" && decodedPayload<{ secret: string }>(m.body).secret === "for b only");
    expect(bGot).toBe(true);
    expect(cGot).toBe(false);
  });

  it("rejects send when participant has not joined", async () => {
    const res = await sendMessage(fix, "ghost", "all", { text: "boo" });
    expect(res.status).toBe(403);
  });

  it("rejects unencrypted message bodies", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ to: "all", body: { text: "nope" } }),
    }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "message body must be encrypted",
      hint: expect.stringContaining("/client/41d.js"),
    });
  });

  it("accepts SDK-shape encrypted bodies", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ to: "all", body: { encrypted: true, ciphertext: "abc", iv: "def" } }),
    }));
    expect(res.status).toBe(200);
  });

  it("accepts plain key.exchange announcements", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ to: "all", intent: "key.exchange", body: { public_key: "raw-key" } }),
    }));
    expect(res.status).toBe(200);
  });

  it("rejects message body too large", async () => {
    await joinParticipant(fix, "agent-a");
    const bigBody = { text: "x".repeat(MAX_BODY_BYTES + 1) };
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ to: "all", body: bigBody }),
    }));
    expect(res.status).toBe(413);
  });

  it("allows participant to leave", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await deleteParticipant(fix, "agent-a");
    expect(res.status).toBe(200);
  });

  it("host can kick a participant", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    const res = await deleteParticipant(fix, "agent-b", "host");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; kicked: string };
    expect(body.kicked).toBe("agent-b");
  });

  it("non-host cannot kick", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    const res = await deleteParticipant(fix, "agent-a", "agent-b");
    expect(res.status).toBe(403);
  });

  it("host can close the room", async () => {
    const res = await closeRoom(fix);
    expect(res.status).toBe(200);
  });

  it("closed room rejects operations", async () => {
    await closeRoom(fix);
    const res = await joinParticipant(fix, "late-guest");
    expect(res.status).toBe(410);
  });

  it("lists participants", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    const body = await getRoomJson<{ participants: Array<{ id: string }> }>(fix, "/participants");
    const ids = body.participants.map((p) => p.id).sort();
    expect(ids).toEqual(["agent-a", "agent-b"]);
  });

  it("supports participant status update", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/participants/agent-a`, {
      method: "PATCH",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ state: "busy", status: "working on tests", model: "test-model", skills: ["testing"] }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; participant: { state: string; status: string; model: string; skills: string[] } };
    expect(body.participant.state).toBe("busy");
    expect(body.participant.status).toBe("working on tests");
    expect(body.participant.model).toBe("test-model");
    expect(body.participant.skills).toEqual(["testing"]);
  });

  it("returns room status", async () => {
    await joinParticipant(fix, "agent-a");
    const body = await getRoomJson<{ room: { room_id: string; host_id: string; invite_id?: string }; closed: boolean; message_count: number }>(fix, "/status");
    expect(body.room.host_id).toBe("host");
    expect(body.room.room_id).toBe(fix.roomId);
    expect(body.room.invite_id).toBeUndefined();
    expect(body.closed).toBe(false);
  });

  it("allows host to export room state", async () => {
    await joinParticipant(fix, "agent-a");
    await sendMessage(fix, "agent-a", "all", { text: "hello" });
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/export`, {
      headers: authHeaders(fix.joinSecret, "host"),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { room: { host_id: string }; participants: Record<string, unknown>; messages: RoomMessage[]; board: Record<string, unknown>; board_schema: unknown; secretHash?: string };
    expect(body.room.host_id).toBe("host");
    expect(body.participants["agent-a"]).toBeDefined();
    expect(body.messages.some((message) => message.from === "agent-a")).toBe(true);
    expect(body.board).toEqual({});
    expect(body.board_schema).toBeNull();
    expect(body.secretHash).toBeUndefined();
  });

  it("rejects non-host room export", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/export`, {
      headers: authHeaders(fix.joinSecret, "agent-a"),
    }));
    expect(res.status).toBe(403);
  });

  it("returns the invite instructions page when unauthenticated", async () => {
    // A GET without auth headers should return the HTML/Markdown invite page
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("41d.us invite");
  });

  it("read returns messages and advances cursor with include_self", async () => {
    await joinParticipant(fix, "agent-a");
    await sendMessage(fix, "agent-a", "all", { text: "msg1" });
    await sendMessage(fix, "agent-a", "all", { text: "msg2" });

    // Read from start with include_self so agent sees own messages
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}?after=0&include_self=true`, {
      headers: authHeaders(fix.joinSecret, "agent-a"),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: RoomMessage[]; cursor: number };
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    expect(body.cursor).toBeGreaterThanOrEqual(2);

    // Read after the cursor — should get nothing new
    const res2 = await readMessages(fix, "agent-a", body.cursor);
    const body2 = (await res2.json()) as { messages: RoomMessage[] };
    expect(body2.messages.length).toBe(0);
  });

  it("tracks read state per participant for recent and all message reads", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await sendMessage(fix, "agent-a", "all", { text: "first" });

    const firstRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: authHeaders(fix.joinSecret, "agent-b"),
    }));
    const firstBody = (await firstRead.json()) as { mode: string; messages: RoomMessage[] };
    expect(firstBody.mode).toBe("recent");
    expect(firstBody.messages.some((m) => decodedPayload<{ text?: string }>(m.body).text === "first")).toBe(true);

    const secondRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: authHeaders(fix.joinSecret, "agent-b"),
    }));
    const secondBody = (await secondRead.json()) as { messages: RoomMessage[] };
    expect(secondBody.messages.length).toBe(0);

    await sendMessage(fix, "agent-a", "all", { text: "second" });
    const recentRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: authHeaders(fix.joinSecret, "agent-b"),
    }));
    const recentBody = (await recentRead.json()) as { messages: RoomMessage[] };
    expect(recentBody.messages.map((m) => decodedPayload<{ text?: string }>(m.body).text)).toEqual(["second"]);

    const allRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}?view=all`, {
      headers: authHeaders(fix.joinSecret, "agent-b"),
    }));
    const allBody = (await allRead.json()) as { mode: string; messages: RoomMessage[] };
    expect(allBody.mode).toBe("all");
    expect(allBody.messages.map((m) => decodedPayload<{ text?: string }>(m.body).text)).toEqual(["first", "second"]);
  });

  it("read markers are isolated per participant", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await joinParticipant(fix, "agent-c");
    await sendMessage(fix, "agent-a", "all", { text: "shared" });

    await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: authHeaders(fix.joinSecret, "agent-b"),
    }));

    const cRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: authHeaders(fix.joinSecret, "agent-c"),
    }));
    const cBody = (await cRead.json()) as { messages: RoomMessage[] };
    expect(cBody.messages.some((m) => decodedPayload<{ text?: string }>(m.body).text === "shared")).toBe(true);
  });
});

describe("board", () => {
  let fix: RoomFixture;

  beforeEach(async () => {
    fix = await bootstrapRoom();
    await joinParticipant(fix, "agent-a");
  });

  it("starts with an empty board", async () => {
    const body = await getRoomJson<{ board: Record<string, unknown> }>(fix, "/board");
    expect(body.board).toEqual({});
  });

  it("sets and reads a board key", async () => {
    const setRes = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ "task-1": { title: "test", state: "todo" } }),
    }));
    const setBody = await setRes.json() as { key: string };
    expect(setBody.key).toBe("tasks");
    const body = await getRoomJson<{ key: string; entry: { value: Record<string, unknown>; updated_by: string } }>(fix, "/board/tasks");
    expect(body.entry.value).toEqual({ "task-1": { title: "test", state: "todo" } });
    expect(body.entry.updated_by).toBe("agent-a");
  });

  it("patches multiple board keys", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`, {
      method: "PATCH",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ kanban: { todo: [], done: [] }, decisions: { api: "REST" } }),
    }));
    expect(res.status).toBe(200);
    const boardRes = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`, {
      headers: authHeaders(fix.joinSecret),
    }));
    const boardBody = (await boardRes.json()) as { board: Record<string, unknown> };
    expect(Object.keys(boardBody.board).sort()).toEqual(["decisions", "kanban"]);
  });

  it("deletes a board key", async () => {
    await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ "task-1": { title: "test" } }),
    }));
    await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "DELETE",
      headers: authHeaders(fix.joinSecret, "agent-a"),
    }));
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`, {
      headers: authHeaders(fix.joinSecret),
    }));
    const body = (await res.json()) as { board: Record<string, unknown> };
    expect(body.board.tasks).toBeUndefined();
  });

  it("validates board against a schema", async () => {
    const schemaFix = await bootstrapRoom({
      boardSchema: {
        type: "object",
        properties: { tasks: { type: "object" } },
        additionalProperties: false,
      },
    });
    await joinParticipant(schemaFix, "agent-a");

    // Valid
    const ok = await schemaFix.session.fetch(new Request(`https://room${schemaFix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...authHeaders(schemaFix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ "task-1": {} }),
    }));
    expect(ok.status).toBe(200);

    // Invalid key (not allowed by schema)
    const bad = await schemaFix.session.fetch(new Request(`https://room${schemaFix.roomPath}/board/unknown_key`, {
      method: "PUT",
      headers: { ...authHeaders(schemaFix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ x: 1 }),
    }));
    expect(bad.status).toBe(422);
  });

  it("rejects board value over size limit", async () => {
    const bigValue = { text: "x".repeat(MAX_BOARD_VALUE_BYTES + 1) };
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/big`, {
      method: "PUT",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify(bigValue),
    }));
    expect(res.status).toBe(413);
  });

  it("requires auth for board access", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`));
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown board key", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/missing`, {
      headers: authHeaders(fix.joinSecret),
    }));
    expect(res.status).toBe(404);
  });

  it("rejects board writes from non-joined participants", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...authHeaders(fix.joinSecret, "ghost"), "content-type": "application/json" },
      body: JSON.stringify({ "task-1": {} }),
    }));
    expect(res.status).toBe(403);
  });

  it("wraps an initial board provided at invite creation", async () => {
    const seeded = await bootstrapRoom({
      hostId: "host",
      initialBoard: { decisions: { api: "REST" } },
    });
    const body = await getRoomJson<{ board: Record<string, { value: unknown; updated_by: string }> }>(seeded, "/board");
    expect(body.board.decisions.value).toEqual({ api: "REST" });
    expect(body.board.decisions.updated_by).toBe("host");
  });

  it("includes board state in host export", async () => {
    await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...authHeaders(fix.joinSecret, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ "task-1": { title: "exported" } }),
    }));
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/export`, {
      headers: authHeaders(fix.joinSecret, "host"),
    }));
    const body = (await res.json()) as { board: Record<string, { value: { "task-1": { title: string } } }> };
    expect(body.board.tasks.value["task-1"].title).toBe("exported");
  });
});
