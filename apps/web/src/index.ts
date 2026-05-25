import { Hono } from "hono";
import type { Context } from "hono";
import { clientPage } from "./client-assets";
import { cliMarkdown, mcpMarkdown, orchestrationMarkdown, piMarkdown, sdkMarkdown, securityMarkdown } from "./markdown-assets";
import { clientScript } from "@41d/helper/client-script";
import { localCryptoPy, localCryptoSh, localCryptoTs } from "@41d/helper/local-crypto-assets";
import { respondNegotiated } from "./format";
import { homeMarkdown, homePage } from "./html";
import { RendezvousSession } from "./rendezvous";
import { securityPage } from "./security";
import { skillExampleMarkdown, skillMarkdown } from "@41d/skill";
import { skillExamplePage, skillPage } from "./skill-pages";
import { handleCreateRoom } from "./invite";
import { handleMcpRequest } from "./mcp-handler";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  respondNegotiated(c.req.raw, homePage, homeMarkdown),
);

app.get("/security", (c) => respondNegotiated(c.req.raw, securityPage, () => securityMarkdown));

app.get("/security/SECURITY.md", (c) =>
  c.body(securityMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="SECURITY.md"',
  }),
);

app.get("/skill", (c) => c.html(skillPage()));

app.get("/skill/examples/*", (c) => {
  const rawSlug = new URL(c.req.url).pathname.split("/").pop() ?? "";
  const wantsMarkdown = rawSlug.endsWith(".md");
  const slug = wantsMarkdown ? rawSlug.slice(0, -3) : rawSlug;

  if (wantsMarkdown) {
    const markdown = skillExampleMarkdown(slug);
    if (!markdown) return c.text("not found", 404);
    return c.body(markdown, 200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `inline; filename="${slug}.md"`,
    });
  }

  const page = skillExamplePage(slug);
  if (!page) return c.text("not found", 404);
  return c.html(page);
});

app.get("/client", (c) => c.html(clientPage()));

app.get("/client/SDK.md", (c) =>
  c.body(sdkMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="SDK.md"',
  }),
);

app.get("/client/PI.md", (c) =>
  c.body(piMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="PI.md"',
  }),
);

app.get("/client/CLI.md", (c) =>
  c.body(cliMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="CLI.md"',
  }),
);

app.get("/client/ORCHESTRATION.md", (c) =>
  c.body(orchestrationMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="ORCHESTRATION.md"',
  }),
);

app.get("/client/MCP.md", (c) =>
  c.body(mcpMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="MCP.md"',
  }),
);

const clientFiles = [
  { path: "/client/41d.js", body: clientScript, type: "application/javascript; charset=utf-8", filename: "41d.js" },
  { path: "/client/crypto.ts", body: localCryptoTs, type: "text/plain; charset=utf-8", filename: "41d-crypto.ts" },
  { path: "/client/crypto.py", body: localCryptoPy, type: "text/x-python; charset=utf-8", filename: "41d_crypto.py" },
  { path: "/client/crypto.sh", body: localCryptoSh, type: "text/x-shellscript; charset=utf-8", filename: "41d-crypto.sh" },
] as const;

for (const file of clientFiles) {
  app.get(file.path, (c) =>
    c.body(file.body, 200, {
      "content-type": file.type,
      "content-disposition": `inline; filename="${file.filename}"`,
    }),
  );
}

app.get("/skill/SKILL.md", (c) =>
  c.body(skillMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'attachment; filename="SKILL.md"',
  }),
);

app.post("/rooms", handleCreateRoom);
app.post("/invites", handleCreateRoom);

// Hosted MCP endpoint — POST for MCP calls, GET for documentation.
app.post("/mcp", (c) => handleMcpRequest(c.req.raw, c.env));
app.get("/mcp", (c) => c.json({
  name: "41d.us MCP endpoint",
  version: "0.1.0",
  protocol: "MCP Streamable HTTP",
  usage: "Send POST requests with JSON-RPC 2.0 bodies",
  docs: "https://41d.us/client/MCP.md",
  configure: {
    mcpServers: { "41d.us": { url: "https://41d.us/mcp" } },
  },
}));

// Both routes are needed: Hono's `*` wildcard matches sub-paths but not the
// bare root path. The first catches the root, the second catches sub-paths.
const routeRoom = (c: Context<{ Bindings: Env }>) => {
  const roomId = c.req.param("roomId");
  if (!roomId) return c.text("not found", 404);
  const raw = c.req.raw;
  if (!raw) return c.text("internal error", 500);
  const id = c.env.RENDEZVOUS.idFromName(roomId);
  const stub = c.env.RENDEZVOUS.get(id);
  return stub.fetch(raw);
};
app.all("/r/:roomId", routeRoom);
app.all("/r/:roomId/*", routeRoom);

app.notFound((c) => c.text("not found", 404));

export default app;
export { RendezvousSession };
