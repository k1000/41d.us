import { Hono } from "hono";
import { clientPage, orchestrationMarkdown, sdkMarkdown } from "./client-assets";
import { clientScript } from "../packages/helper/src/client-script";
import { localCryptoPy, localCryptoSh, localCryptoTs } from "../packages/helper/src/local-crypto-assets";
import { respondNegotiated } from "./format";
import { homeMarkdown, homePage } from "./html";
import { RendezvousSession } from "./rendezvous";
import { securityMarkdown, securityPage } from "./security";
import { skillExampleMarkdown, skillMarkdown } from "../packages/skill/src/skill";
import { skillExamplePage, skillPage } from "./skill-pages";
import { handleCreateInvite } from "./invite";
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

app.get("/client/ORCHESTRATION.md", (c) =>
  c.body(orchestrationMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="ORCHESTRATION.md"',
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

app.post("/invites", handleCreateInvite);

app.all("/r/:roomId", (c) => {
  const roomId = c.req.param("roomId");
  const id = c.env.RENDEZVOUS.idFromName(roomId);
  const stub = c.env.RENDEZVOUS.get(id);
  return stub.fetch(c.req.raw);
});

app.all("/r/:roomId/*", (c) => {
  const roomId = c.req.param("roomId");
  const id = c.env.RENDEZVOUS.idFromName(roomId);
  const stub = c.env.RENDEZVOUS.get(id);
  return stub.fetch(c.req.raw);
});

app.notFound((c) => c.text("not found", 404));

export default app;
export { RendezvousSession };
