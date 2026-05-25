/**
 * Structured error thrown by the SDK when an API request fails.
 */
export class RoomApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, url: string) {
    super(`${url} failed: ${status} ${body}`);
    this.name = "RoomApiError";
    this.status = status;
    this.body = body;
  }
}
