import { describe, expect, it } from "vitest";
import { parseArgs, splitArgs } from "../args";

describe("pi-extension args", () => {
  it("parses room-url command form", () => {
    expect(parseArgs(["send", "https://41d.us/r/room", "secret", "agent-a", "all", '{"text":"hi"}'])).toEqual({
      cmd: "send",
      roomUrlOrInvite: "https://41d.us/r/room",
      joinSecret: "secret",
      me: "agent-a",
      rest: ["all", '{"text":"hi"}'],
    });
  });

  it("parses invite-file command form", () => {
    expect(parseArgs(["read", "room.json", "agent-b"])).toEqual({
      cmd: "read",
      roomUrlOrInvite: "room.json",
      me: "agent-b",
      rest: [],
    });
  });

  it("uses env room values for compact send commands", () => {
    expect(parseArgs(["send", "all", "{}"], {
      ROOM_URL: "https://41d.us/r/env-room",
      JOIN_SECRET: "env-secret",
      ME: "agent-env",
    })).toEqual({
      cmd: "send",
      roomUrlOrInvite: "https://41d.us/r/env-room",
      joinSecret: "env-secret",
      me: "agent-env",
      rest: ["all", "{}"],
    });
  });

  it("splits quoted command strings", () => {
    expect(splitArgs("send room.json agent-a all '{\"text\":\"hello world\"}'")).toEqual([
      "send",
      "room.json",
      "agent-a",
      "all",
      '{"text":"hello world"}',
    ]);
  });
});
