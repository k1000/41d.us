import { Hono } from "hono";
import { hashJoinSecret, randomBase64Url } from "./crypto";
import { homeMarkdown, homePage, shouldReturnMarkdown } from "./html";
import { RendezvousSession } from "./rendezvous";
import { skillMarkdown, skillPage } from "./skill";
import type { Env, InviteState } from "./types";

const INVITE_TTL_MS = 10 * 60 * 1000;

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  if (shouldReturnMarkdown(c.req.raw)) {
    return c.body(homeMarkdown(), 200, { "content-type": "text/markdown; charset=utf-8" });
  }
  return c.html(homePage());
});

app.get("/skill", (c) => c.html(skillPage()));

app.get("/skill/SKILL.md", (c) =>
  c.body(skillMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'attachment; filename="SKILL.md"',
  }),
);

app.post("/invites", async (c) => {
  const inviteId = randomBase64Url(16);
  const joinSecret = randomBase64Url(32);
  const expiresAt = Date.now() + INVITE_TTL_MS;
  const secretHash = await hashJoinSecret(inviteId, joinSecret);

  const state: InviteState = {
    inviteId,
    secretHash,
    expiresAt,
    phase: "waiting",
    aConfirmed: false,
    bConfirmed: false,
  };

  const id = c.env.RENDEZVOUS.idFromName(inviteId);
  const stub = c.env.RENDEZVOUS.get(id);
  const initResponse = await stub.fetch("https://rendezvous.internal/__init", {
    method: "POST",
    body: JSON.stringify(state),
    headers: { "content-type": "application/json" },
  });

  if (!initResponse.ok) {
    return c.json({ error: "failed to create invite" }, 500);
  }

  const requestUrl = new URL(c.req.url);
  const wsProtocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsProtocol}//${requestUrl.host}/r/${inviteId}`;

  return c.json({
    invite_id: inviteId,
    join_secret: joinSecret,
    url,
    readme: `${requestUrl.protocol}//${requestUrl.host}/skill/SKILL.md`,
    expires_at: new Date(expiresAt).toISOString(),
  });
});

app.get("/r/:inviteId", (c) => {
  const inviteId = c.req.param("inviteId");
  const id = c.env.RENDEZVOUS.idFromName(inviteId);
  const stub = c.env.RENDEZVOUS.get(id);
  return stub.fetch(c.req.raw);
});

app.notFound((c) => c.text("not found", 404));

export default app;
export { RendezvousSession };
