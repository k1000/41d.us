import type { Invite } from "./sdk";

export async function request<T>(
  url: string,
  invite: Invite,
  options: { method?: string; participantId?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${invite.join_secret}` };
  if (options.participantId) headers["x-participant-id"] = options.participantId;
  const hasBody = options.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
