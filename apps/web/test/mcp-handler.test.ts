import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../src/mcp-handler";

function rpc(method: string, params?: Record<string, unknown>): Request {
  return new Request("https://41d.us/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function resultText(response: Response): Promise<any> {
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0].text);
}

describe("hosted MCP handler", () => {
  it("rejects non-POST requests", async () => {
    const response = await handleMcpRequest(new Request("https://41d.us/mcp"));

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32000 } });
  });

  it("rejects invalid JSON", async () => {
    const response = await handleMcpRequest(new Request("https://41d.us/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32700 } });
  });

  it("handles initialize", async () => {
    const response = await handleMcpRequest(rpc("initialize"));
    const body = await resultText(response) as { serverInfo: { name: string } };

    expect(response.status).toBe(200);
    expect(body.serverInfo.name).toBe("41d.us");
  });

  it("lists tools", async () => {
    const response = await handleMcpRequest(rpc("tools/list"));
    const body = await resultText(response) as { tools: Array<{ name: string }> };

    expect(body.tools.map((tool) => tool.name)).toContain("create_room");
    expect(body.tools.map((tool) => tool.name)).toContain("send_message");
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
});
