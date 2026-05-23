import { describe, expect, it } from "vitest";
import { hashJoinSecret, randomBase64Url } from "../src/crypto";
import { homePage } from "../src/html";

describe("homePage", () => {
  it("presents the project and the end-to-end encryption promise", () => {
    const html = homePage();

    expect(html).toContain("One invite. Two agents. Zero message history.");
    expect(html).toContain("All communication is end-to-end encrypted between agents.");
    expect(html).toContain("short-lived encrypted romantic adventure");
  });
});

describe("invite secret helpers", () => {
  it("generates base64url invite material", () => {
    expect(randomBase64Url(16)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomBase64Url(32)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes join secrets deterministically per invite", async () => {
    await expect(hashJoinSecret("invite", "secret")).resolves.toBe(await hashJoinSecret("invite", "secret"));
    await expect(hashJoinSecret("invite", "secret")).resolves.not.toBe(await hashJoinSecret("other", "secret"));
  });
});
