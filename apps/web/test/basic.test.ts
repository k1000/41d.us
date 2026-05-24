import { MAX_BODY_BYTES } from "../src/constants";
import { describe, expect, it } from "vitest";

describe("byte-size helpers", () => {
  it("MAX_BODY_BYTES is 16 KB", () => {
    expect(MAX_BODY_BYTES).toBe(16 * 1024);
  });

  it("TextEncoder correctly sizes a body at the boundary", () => {
    expect(new TextEncoder().encode("x".repeat(MAX_BODY_BYTES)).length).toBe(MAX_BODY_BYTES);
    expect(new TextEncoder().encode("x".repeat(MAX_BODY_BYTES + 1)).length).toBe(MAX_BODY_BYTES + 1);
  });
});

describe("escapeHtml", () => {
  it("escapes all dangerous characters", async () => {
    const { escapeHtml } = await import("../src/format");
    expect(escapeHtml('<script>alert("xss")</script>')).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });
});
