import { beforeEach, describe, expect, it } from "vitest";
import {
  authHeaders,
  bootstrapRoom,
  joinParticipant,
  type RoomFixture,
} from "./room/helpers";

const KANBAN_STATES = {
  active: { transitions: { close: "closed" } },
  closed: { transitions: {} },
};

const MILESTONE_STATES = {
  planning: {
    transitions: { begin: "in_progress" },
    board_acls: { tasks: "host_only" as const },
  },
  in_progress: {
    transitions: { review: "review" },
    board_acls: { tasks: "anyone" as const },
  },
  review: {
    transitions: { approve: "completed" },
    board_acls: { tasks: "host_only" as const },
  },
  completed: { transitions: {} },
};

async function transitionRoom(
  fix: RoomFixture,
  participantId: string,
  event: string,
): Promise<Response> {
  return fix.session.fetch(
    new Request(`https://room${fix.roomPath}/transition`, {
      method: "POST",
      headers: { ...authHeaders(fix.joinSecret, participantId), "content-type": "application/json" },
      body: JSON.stringify({ event }),
    }),
  );
}

describe("room state machine", () => {
  let fix: RoomFixture;

  beforeEach(async () => {
    fix = await bootstrapRoom({
      hostId: "host",
      phase: "active",
      roomStates: KANBAN_STATES,
    });
    await joinParticipant(fix, "host");
  });

  it("preserves the room phase when a participant joins a stateful room", async () => {
    await joinParticipant(fix, "agent-a");
    const exportRes = await fix.session.fetch(
      new Request(`https://room${fix.roomPath}/export`, { headers: authHeaders(fix.joinSecret, "host") }),
    );
    const body = await exportRes.json() as { phase: string };
    expect(body.phase).toBe("active");
  });

  it("transitions the room state on a valid event", async () => {
    const res = await transitionRoom(fix, "host", "close");
    expect(res.status).toBe(200);
    const body = await res.json() as { from: string; to: string; event: string };
    expect(body).toMatchObject({ from: "active", to: "closed", event: "close" });
  });

  it("rejects transitions from non-host participants", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await transitionRoom(fix, "agent-a", "close");
    expect(res.status).toBe(403);
  });

  it("rejects transitions with unknown events", async () => {
    const res = await transitionRoom(fix, "host", "nope");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; available_events: string[] };
    expect(body.available_events).toContain("close");
  });

  it("rejects transitions when no state machine is configured", async () => {
    const plain = await bootstrapRoom();
    await joinParticipant(plain, "host");
    const res = await transitionRoom(plain, "host", "close");
    expect(res.status).toBe(400);
  });

  it("rejects transitions when the event is missing", async () => {
    const res = await fix.session.fetch(
      new Request(`https://room${fix.roomPath}/transition`, {
        method: "POST",
        headers: { ...authHeaders(fix.joinSecret, "host"), "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
  });
});

async function setBoardKey(fix: RoomFixture, participantId: string, key: string, value: unknown): Promise<Response> {
  return fix.session.fetch(
    new Request(`https://room${fix.roomPath}/board/${key}`, {
      method: "PUT",
      headers: { ...authHeaders(fix.joinSecret, participantId), "content-type": "application/json" },
      body: JSON.stringify(value),
    }),
  );
}

async function deleteBoardKey(fix: RoomFixture, participantId: string, key: string): Promise<Response> {
  return fix.session.fetch(
    new Request(`https://room${fix.roomPath}/board/${key}`, {
      method: "DELETE",
      headers: authHeaders(fix.joinSecret, participantId),
    }),
  );
}

describe("board ACLs", () => {
  let fix: RoomFixture;

  beforeEach(async () => {
    fix = await bootstrapRoom({
      hostId: "host",
      boardAcls: { milestones: "host_only", tasks: "anyone" },
    });
    await joinParticipant(fix, "host");
    await joinParticipant(fix, "agent-a");
  });

  it("lets the host write host_only keys", async () => {
    const res = await setBoardKey(fix, "host", "milestones", { m1: "ship v1" });
    expect(res.status).toBe(200);
  });

  it("blocks non-host writes to host_only keys", async () => {
    const res = await setBoardKey(fix, "agent-a", "milestones", { m1: "noop" });
    expect(res.status).toBe(403);
  });

  it("allows non-host writes to anyone keys", async () => {
    const res = await setBoardKey(fix, "agent-a", "tasks", { t1: "todo" });
    expect(res.status).toBe(200);
  });

  it("blocks non-host deletes on host_only keys", async () => {
    await setBoardKey(fix, "host", "milestones", { m1: "ship v1" });
    const res = await deleteBoardKey(fix, "agent-a", "milestones");
    expect(res.status).toBe(403);
  });

  it("allows host deletes on host_only keys", async () => {
    await setBoardKey(fix, "host", "milestones", { m1: "ship v1" });
    const res = await deleteBoardKey(fix, "host", "milestones");
    expect(res.status).toBe(200);
  });

  it("applies per-state ACL overrides over room-level ACLs", async () => {
    const stateful = await bootstrapRoom({
      hostId: "host",
      phase: "review",
      boardAcls: { tasks: "anyone" },
      roomStates: MILESTONE_STATES,
    });
    await joinParticipant(stateful, "host");
    await joinParticipant(stateful, "agent-a");
    // In review state, tasks become host_only via per-state override
    const blocked = await setBoardKey(stateful, "agent-a", "tasks", { t1: "noop" });
    expect(blocked.status).toBe(403);
  });
});

describe("per-participant tokens", () => {
  let fix: RoomFixture;

  beforeEach(async () => {
    fix = await bootstrapRoom();
  });

  it("returns a participant_token on join", async () => {
    const res = await joinParticipant(fix, "agent-a");
    expect(res.status).toBe(200);
    const body = await res.json() as { participant_token?: string };
    expect(body.participant_token).toBeTruthy();
    expect(body.participant_token!.length).toBeGreaterThan(10);
  });

  it("authenticates writes with a per-participant token (no x-participant-id needed)", async () => {
    const joinRes = await joinParticipant(fix, "agent-a");
    const { participant_token } = await joinRes.json() as { participant_token: string };

    const send = await fix.session.fetch(
      new Request(`https://room${fix.roomPath}`, {
        method: "POST",
        headers: { authorization: `Bearer ${participant_token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "all", body: { encrypted_payload: "{}" } }),
      }),
    );
    expect(send.status).toBe(200);
  });

  it("rejects an unknown bearer token", async () => {
    await joinParticipant(fix, "agent-a");
    const send = await fix.session.fetch(
      new Request(`https://room${fix.roomPath}`, {
        method: "POST",
        headers: { authorization: "Bearer bogus-token", "content-type": "application/json" },
        body: JSON.stringify({ to: "all", body: { encrypted_payload: "{}" } }),
      }),
    );
    expect(send.status).toBe(403);
  });
});
