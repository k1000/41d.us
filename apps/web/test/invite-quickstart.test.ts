import { describe, expect, it } from "vitest";
import { buildApiLinks, buildQuickstart } from "../src/invite-quickstart";

describe("buildApiLinks", () => {
  it("builds read_all as roomUrl + /?view=all (no literal {room_id} placeholder)", () => {
    const links = buildApiLinks("https://41d.us/r/abc");
    expect(links.read_all).toBe("https://41d.us/r/abc/?view=all");
    expect(links.read_all).not.toContain("{room_id}");
  });

  it("preserves participant_id placeholders for client templating", () => {
    const links = buildApiLinks("https://41d.us/r/abc");
    expect(links.join).toBe("https://41d.us/r/abc/participants/{participant_id}");
    expect(links.kick).toBe("https://41d.us/r/abc/participants/{target_id}");
  });

  it("builds endpoint URLs anchored at the roomUrl", () => {
    const links = buildApiLinks("https://41d.us/r/abc");
    expect(links.events).toBe("https://41d.us/r/abc/events");
    expect(links.board).toBe("https://41d.us/r/abc/board");
    expect(links.status).toBe("https://41d.us/r/abc/status");
    expect(links.export).toBe("https://41d.us/r/abc/export");
  });
});

describe("buildQuickstart", () => {
  it("uses the room name to derive the room file name", () => {
    const qs = buildQuickstart("https://41d.us/r/abc", "secret", "agent-a", "Review Room");
    expect(qs.create_room_file).toContain("> Review-Room.json");
    expect(qs.join_from_room_file).toContain("Review-Room.json");
  });

  it("defaults the room file to 'room.json' when no name is given", () => {
    const qs = buildQuickstart("https://41d.us/r/abc", "secret", "agent-a");
    expect(qs.create_room_file).toContain("> room.json");
  });

  it("URL-encodes the participant id when it appears in a path", () => {
    const qs = buildQuickstart("https://41d.us/r/abc", "secret", "agent a/b");
    expect(qs.set_busy).toContain(`/participants/${encodeURIComponent("agent a/b")}`);
    expect(qs.join_diagnostic_only).toContain(`/participants/${encodeURIComponent("agent a/b")}`);
  });
});
