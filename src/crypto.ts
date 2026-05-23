export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function hashJoinSecret(inviteId: string, secret: string): Promise<string> {
  const input = new TextEncoder().encode(`${inviteId}.${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
