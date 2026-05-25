import { describe, expect, it } from "vitest";
import { parseFirstMessage, parseInvite, parseSkills } from "../src/index";

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

    it("parses a minimal access handoff", () => {
      const invite = parseInvite(JSON.stringify({ access: "https://41d.us/r/abc", join_secret: "secret" }));
      expect(invite.room_url).toBe("https://41d.us/r/abc");
      expect(invite.room_id).toBe("abc");
    });

    it("throws when required fields are missing", () => {
      expect(() => parseInvite(JSON.stringify({ access: "https://41d.us/r/abc" }))).toThrow(/join_secret/);
      expect(() => parseInvite(JSON.stringify({ join_secret: "y" }))).toThrow(/access/);
      expect(() => parseInvite("{}")).toThrow();
    });

    it("throws on invalid JSON", () => {
      expect(() => parseInvite("not json")).toThrow();
    });
  });

  describe("parseFirstMessage", () => {
    it("returns the parsed object when given a JSON object string", () => {
      expect(parseFirstMessage('{"text":"hi","workflow":"go"}')).toEqual({ text: "hi", workflow: "go" });
    });

    it("returns the raw string for plain text", () => {
      expect(parseFirstMessage("just a plain message")).toBe("just a plain message");
    });

    it("returns the raw string when the JSON is invalid", () => {
      expect(parseFirstMessage('{"text":"oops')).toBe('{"text":"oops');
    });

    it("returns the raw string for JSON arrays or primitives", () => {
      expect(parseFirstMessage("[1,2,3]")).toBe("[1,2,3]");
      expect(parseFirstMessage("42")).toBe("42");
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
