import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../src/mcp-handler";
import { RoomEvents } from "../src/room/events";

function rpc(method: string, params?: Record<string, unknown>, sessionId?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return new Request("https://j01n.me/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function initSession(): Promise<string> {
  const response = await handleMcpRequest(rpc("initialize"));
  return response.headers.get("mcp-session-id")!;
}

async function toolResultText<T = unknown>(response: Response): Promise<T> {
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0].text) as T;
}

const TEST_INVITE = JSON.stringify({ access: "https://j01n.me/r/test-room", join_secret: "secret" });

function getWithSession(sessionId: string): Request {
  return new Request("https://j01n.me/mcp", { method: "GET", headers: { "mcp-session-id": sessionId } });
}

function deleteSession(sessionId: string): Request {
  return new Request("https://j01n.me/mcp", { method: "DELETE", headers: { "mcp-session-id": sessionId } });
}

function makeRoomEnv(events: RoomEvents) {
  return {
    RENDEZVOUS: {
      idFromName: () => "id",
      get: () => ({ fetch: async () => events.subscribe("agent-a", false, 0) }),
    },
  } as never;
}

const NOOP_WAIT_UNTIL = { waitUntil: () => {} };
const NOOP_ENV = { RENDEZVOUS: {} } as never;

describe("hosted MCP handler", () => {
  it("rejects unsupported methods", async () => {
    const response = await handleMcpRequest(new Request("https://j01n.me/mcp", { method: "PATCH" }));

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32000 } });
  });

  it("GET without a session returns documentation JSON", async () => {
    const response = await handleMcpRequest(new Request("https://j01n.me/mcp"));

    expect(response.status).toBe(200);
    const body = await response.json() as { protocol: string; configure: unknown };
    expect(body.protocol).toBe("MCP Streamable HTTP");
    expect(body.configure).toBeTruthy();
  });

  it("rejects invalid JSON", async () => {
    const response = await handleMcpRequest(new Request("https://j01n.me/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32700 } });
  });

  it("handles initialize", async () => {
    const response = await handleMcpRequest(rpc("initialize"));
    const body = await response.json() as { result: { serverInfo: { name: string } } };

    expect(response.status).toBe(200);
    expect(body.result.serverInfo.name).toBe("j01n.me");
  });

  it("lists tools", async () => {
    const response = await handleMcpRequest(rpc("tools/list"));
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };

    expect(body.result.tools.map((tool) => tool.name)).toContain("create_room");
    expect(body.result.tools.map((tool) => tool.name)).toContain("send_message");
  });

  it("wraps tool call results as MCP content", async () => {
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "get_room_info",
      arguments: { inviteJson: JSON.stringify({ access: "https://j01n.me/r/test-room", join_secret: "secret" }) },
    }), {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => Response.json({ ok: true }),
        }),
      },
    } as never);
    const body = await toolResultText<{ ok: boolean }>(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("surfaces deleted room errors clearly from tool calls", async () => {
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "get_room_info",
      arguments: { inviteJson: JSON.stringify({ access: "https://j01n.me/r/deleted-room", join_secret: "secret" }) },
    }), {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => Response.json({
            error: "room not found",
            reason: "room does not exist or has been deleted",
            deleted: true,
          }, { status: 404 }),
        }),
      },
    } as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32603,
        message: "/status failed: 404 room not found: room does not exist or has been deleted",
      },
    });
  });

  it("returns a JSON-RPC error for unknown tools", async () => {
    const response = await handleMcpRequest(rpc("tools/call", { name: "missing_tool", arguments: {} }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32601 } });
  });

  it("returns a JSON-RPC error for unknown methods", async () => {
    const response = await handleMcpRequest(rpc("missing/method"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32601 } });
  });

  it("accepts initialized notifications without a body", async () => {
    const response = await handleMcpRequest(rpc("notifications/initialized"));

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("lists watch_room as an available tool", async () => {
    const response = await handleMcpRequest(rpc("tools/list"));
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };

    expect(body.result.tools.map((tool) => tool.name)).toContain("watch_room");
  });

  it("watch_room streams room events as MCP JSON-RPC notifications", async () => {
    const events = new RoomEvents();
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "watch_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }), makeRoomEnv(events));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      events.notifyMessage({
        id: "m1", seq: 5, from: "agent-b", to: "agent-a",
        reply_to: null, intent: "notify", priority: "normal",
        body: {}, created_at: new Date(0).toISOString(),
      }, 5);

      const chunk = decoder.decode((await reader.read()).value);
      expect(chunk).toContain("event: message");
      expect(chunk).toContain('"method":"notifications/j01n.me/message"');
      expect(chunk).toContain('"last_seq":5');
    } finally {
      await reader.cancel();
    }
  });

  it("initialize mints a Mcp-Session-Id header", async () => {
    const response = await handleMcpRequest(rpc("initialize"));

    expect(response.status).toBe(200);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("GET with Mcp-Session-Id opens a listening SSE stream", async () => {
    const sessionId = await initSession();
    const response = await handleMcpRequest(getWithSession(sessionId));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      const ready = decoder.decode((await reader.read()).value);
      expect(ready).toContain("notifications/j01n.me/listening");
      expect(ready).toContain(sessionId);
    } finally {
      await reader.cancel();
    }
  });

  it("allows replacing a listening stream for the same session", async () => {
    const sessionId = await initSession();
    const first = await handleMcpRequest(getWithSession(sessionId));
    const second = await handleMcpRequest(getWithSession(sessionId));

    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("text/event-stream");
    await first.body!.cancel();
    await second.body!.cancel();
  });

  it("subscribe_room forwards room events into the session's listening stream", async () => {
    const sessionId = await initSession();
    const listening = await handleMcpRequest(getWithSession(sessionId));
    const reader = listening.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // listening notification

    const events = new RoomEvents();
    const env = makeRoomEnv(events);

    const subResponse = await handleMcpRequest(rpc("tools/call", {
      name: "subscribe_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }, sessionId), env, NOOP_WAIT_UNTIL);
    const subResult = await toolResultText<{ ok: boolean; subscription_id: string }>(subResponse);
    expect(subResult.ok).toBe(true);
    expect(subResult.subscription_id).toMatch(/^[0-9a-f-]{36}$/);

    events.notifyMessage({
      id: "m1", seq: 7, from: "agent-b", to: "agent-a",
      reply_to: null, intent: "notify", priority: "normal",
      body: {}, created_at: new Date(0).toISOString(),
    }, 7);

    try {
      const frame = decoder.decode((await reader.read()).value);
      expect(frame).toContain("id: 1");
      expect(frame).toContain('"method":"notifications/j01n.me/message"');
      expect(frame).toContain('"last_seq":7');
    } finally {
      await reader.cancel();
    }
  });

  it("subscribe_room without an active listening stream errors", async () => {
    const sessionId = await initSession();
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "subscribe_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }, sessionId), NOOP_ENV);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("no active listening stream") },
    });
  });

  it("subscribe_room without Mcp-Session-Id errors", async () => {
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "subscribe_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }), NOOP_ENV);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("requires the Mcp-Session-Id header") },
    });
  });

  it("unsubscribe_room cancels an active subscription", async () => {
    const sessionId = await initSession();
    const listening = await handleMcpRequest(getWithSession(sessionId));
    const reader = listening.body!.getReader();
    await reader.read(); // listening notification

    const events = new RoomEvents();
    const env = makeRoomEnv(events);

    const subResponse = await handleMcpRequest(rpc("tools/call", {
      name: "subscribe_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }, sessionId), env, NOOP_WAIT_UNTIL);
    const subResult = await toolResultText<{ subscription_id: string }>(subResponse);

    const unsubResponse = await handleMcpRequest(rpc("tools/call", {
      name: "unsubscribe_room",
      arguments: { subscriptionId: subResult.subscription_id },
    }, sessionId), env);

    expect(await toolResultText(unsubResponse)).toMatchObject({ ok: true, found: true });
    await reader.cancel();
  });

  it("unsubscribe_room is idempotent for unknown subscriptions", async () => {
    const sessionId = await initSession();
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "unsubscribe_room",
      arguments: { subscriptionId: "does-not-exist" },
    }, sessionId), NOOP_ENV);

    expect(await toolResultText(response)).toMatchObject({ ok: true, found: false });
  });

  it("DELETE without Mcp-Session-Id is a 400", async () => {
    const response = await handleMcpRequest(new Request("https://j01n.me/mcp", { method: "DELETE" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("missing Mcp-Session-Id") },
    });
  });

  it("DELETE with Mcp-Session-Id tears down the session", async () => {
    const sessionId = await initSession();
    const response = await handleMcpRequest(deleteSession(sessionId));

    expect(response.status).toBe(204);

    const listening = await handleMcpRequest(getWithSession(sessionId));
    expect(listening.status).toBe(200);
    expect(listening.headers.get("content-type")).toBe("text/event-stream");
    await listening.body!.cancel();
  });

  it("watch_room surfaces upstream auth failures as a JSON-RPC error", async () => {
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({ fetch: async () => new Response("forbidden", { status: 403 }) }),
      },
    } as never;

    const response = await handleMcpRequest(rpc("tools/call", {
      name: "watch_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }), env);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32603, message: expect.stringContaining("/events failed: 403") },
    });
  });
});
