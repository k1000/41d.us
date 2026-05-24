import { describe, expect, it } from "vitest";
import { parseInvite, parseSkills } from "../src/index";

describe("mcp-server helpers", () => {
  describe("parseInvite", () => {
    const validInvite = JSON.stringify({
      room_url: "https://41d.us/r/abc",
      join_secret: "secret",
      room_id: "abc",
      api: { board: "https://41d.us/r/abc/board" },
    });

    it("parses a valid invite", () => {
      const invite = parseInvite(validInvite);
      expect(invite.room_id).toBe("abc");
    });

    it("throws when required fields are missing", () => {
      expect(() => parseInvite(JSON.stringify({ room_url: "x", join_secret: "y", room_id: "z" }))).toThrow(/api/);
      expect(() => parseInvite(JSON.stringify({ room_url: "x", join_secret: "y", api: {} }))).toThrow();
      expect(() => parseInvite("{}")).toThrow();
    });

    it("throws on invalid JSON", () => {
      expect(() => parseInvite("not json")).toThrow();
    });
  });

  describe("parseSkills", () => {
    it("returns undefined for missing or empty input", () => {
      expect(parseSkills(undefined)).toBeUndefined();
      expect(parseSkills("")).toBeUndefined();
    });

    it("splits, trims, and filters comma-separated skills", () => {
      expect(parseSkills("ts,react,docs")).toEqual(["ts", "react", "docs"]);
      expect(parseSkills(" ts , react , docs ")).toEqual(["ts", "react", "docs"]);
      expect(parseSkills("ts,,react")).toEqual(["ts", "react"]);
    });
  });
});
