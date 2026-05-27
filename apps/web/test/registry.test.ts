import { describe, expect, it } from "vitest";
import { RoomRegistry, registerRoom, sweepStaleRooms } from "../src/room/registry";

function createMockState(): DurableObjectState {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { storage.set(key, value); },
      delete: async (key: string) => storage.delete(key),
      deleteAll: async () => storage.clear(),
      list: async <T>() => new Map(
        [...storage.entries()].filter(([k]) => k.startsWith("room:")) as Array<[string, T]>,
      ),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      sync: async () => {},
      transaction: async <T>(fn: () => Promise<T>) => fn(),
    },
    id: { toString: () => "registry-do" },
    waitUntil: async () => {},
    blockConcurrencyWhile: async () => {},
  } as unknown as DurableObjectState;
}

function createRendezvousNamespaceWith(handler: (roomId: string) => Response): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: unknown) => ({
      fetch: async () => handler(String(id)),
    }),
  } as unknown as DurableObjectNamespace;
}

async function postSweep(registry: RoomRegistry): Promise<Record<string, unknown>> {
  const res = await registry.fetch(new Request("https://room-registry.internal/sweep", { method: "POST" }));
  return (await res.json()) as Record<string, unknown>;
}

async function registerEntry(registry: RoomRegistry, roomId: string, expiresAt: number): Promise<Response> {
  return registry.fetch(new Request("https://room-registry.internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room_id: roomId, expires_at: expiresAt }),
  }));
}

describe("RoomRegistry", () => {
  it("rejects register without room_id or expires_at", async () => {
    const registry = new RoomRegistry(createMockState(), { RENDEZVOUS: {} as DurableObjectNamespace });
    const res = await registry.fetch(new Request("https://room-registry.internal/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown routes", async () => {
    const registry = new RoomRegistry(createMockState(), { RENDEZVOUS: {} as DurableObjectNamespace });
    const res = await registry.fetch(new Request("https://room-registry.internal/unknown"));
    expect(res.status).toBe(404);
  });

  it("retains entries whose expires_at is in the future", async () => {
    const registry = new RoomRegistry(createMockState(), {
      RENDEZVOUS: createRendezvousNamespaceWith(() => new Response(JSON.stringify({ ok: true, deleted: true }))),
    });
    await registerEntry(registry, "future-room", Date.now() + 60_000);

    expect(await postSweep(registry)).toMatchObject({ ok: true, retained: 1, deleted: 0, errors: [] });
  });

  it("deletes entries whose cleanup succeeds", async () => {
    const registry = new RoomRegistry(createMockState(), {
      RENDEZVOUS: createRendezvousNamespaceWith(() => new Response(JSON.stringify({ ok: true, deleted: true }))),
    });
    await registerEntry(registry, "expired-room", Date.now() - 1_000);

    expect(await postSweep(registry)).toMatchObject({ ok: true, deleted: 1, retained: 0 });
  });

  it("collects errors when cleanup fails with a non-success status", async () => {
    const registry = new RoomRegistry(createMockState(), {
      RENDEZVOUS: createRendezvousNamespaceWith(() => new Response("boom", { status: 500 })),
    });
    await registerEntry(registry, "broken-room", Date.now() - 1_000);
    const body = await postSweep(registry);

    expect(body).toMatchObject({ ok: false, deleted: 0, retained: 0 });
    expect((body.errors as Array<{ room_id: string; error: string }>)[0]).toMatchObject({ room_id: "broken-room" });
  });

  it("treats 404/410 cleanup as a successful delete", async () => {
    const registry = new RoomRegistry(createMockState(), {
      RENDEZVOUS: createRendezvousNamespaceWith(() => new Response("gone", { status: 410 })),
    });
    await registerEntry(registry, "gone-room", Date.now() - 1_000);

    expect(await postSweep(registry)).toMatchObject({ ok: true, deleted: 1 });
  });
});

describe("registerRoom helper", () => {
  it("no-ops when ROOM_REGISTRY binding is absent", async () => {
    await expect(registerRoom({ RENDEZVOUS: {} as DurableObjectNamespace }, "room", 1)).resolves.toBeUndefined();
  });
});

describe("sweepStaleRooms helper", () => {
  it("returns skipped marker when ROOM_REGISTRY binding is absent", async () => {
    const res = await sweepStaleRooms({ RENDEZVOUS: {} as DurableObjectNamespace });
    expect(await res.json()).toMatchObject({ ok: true, skipped: expect.stringContaining("ROOM_REGISTRY") });
  });
});
