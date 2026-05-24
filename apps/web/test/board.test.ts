import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BOARD_VALUE_BYTES } from "../src/constants";
import type { RoomMessage } from "../src/types";
import {
  bootstrapRoom,
  getRoomJson,
  joinParticipant,
  type RoomFixture,
} from "./room/helpers";

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
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "agent-a", "content-type": "application/json" },
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
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "agent-a", "content-type": "application/json" },
      body: JSON.stringify({ kanban: { todo: [], done: [] }, decisions: { api: "REST" } }),
    }));
    expect(res.status).toBe(200);
    const boardRes = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`, {
      headers: { authorization: `Bearer ${fix.joinSecret}` },
    }));
    const boardBody = (await boardRes.json()) as { board: Record<string, unknown> };
    expect(Object.keys(boardBody.board).sort()).toEqual(["decisions", "kanban"]);
  });

  it("deletes a board key", async () => {
    await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "agent-a", "content-type": "application/json" },
      body: JSON.stringify({ "task-1": { title: "test" } }),
    }));
    await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "agent-a" },
    }));
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`, {
      headers: { authorization: `Bearer ${fix.joinSecret}` },
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

    // Valid write
    const ok = await schemaFix.session.fetch(new Request(`https://room${schemaFix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { authorization: `Bearer ${schemaFix.joinSecret}`, "x-participant-id": "agent-a", "content-type": "application/json" },
      body: JSON.stringify({ "task-1": {} }),
    }));
    expect(ok.status).toBe(200);

    // Invalid key (not allowed by schema)
    const bad = await schemaFix.session.fetch(new Request(`https://room${schemaFix.roomPath}/board/unknown_key`, {
      method: "PUT",
      headers: { authorization: `Bearer ${schemaFix.joinSecret}`, "x-participant-id": "agent-a", "content-type": "application/json" },
      body: JSON.stringify({ x: 1 }),
    }));
    expect(bad.status).toBe(422);
  });

  it("rejects board value over size limit", async () => {
    const bigValue = { text: "x".repeat(MAX_BOARD_VALUE_BYTES + 1) };
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/big`, {
      method: "PUT",
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "agent-a", "content-type": "application/json" },
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
      headers: { authorization: `Bearer ${fix.joinSecret}` },
    }));
    expect(res.status).toBe(404);
  });

  it("rejects board writes from non-joined participants", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "ghost", "content-type": "application/json" },
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
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "agent-a", "content-type": "application/json" },
      body: JSON.stringify({ "task-1": { title: "exported" } }),
    }));
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/export`, {
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "host" },
    }));
    const body = (await res.json()) as { board: Record<string, { value: { "task-1": { title: string } } }> };
    expect(body.board.tasks.value["task-1"].title).toBe("exported");
  });
});
