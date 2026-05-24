/**
 * Shared test helpers for room lifecycle tests.
 *
 * Creates a mock DurableObjectState backed by in-memory Map and provides
 * helper functions for making authenticated requests against a RendezvousSession.
 */

import { DEFAULT_MAX_PARTICIPANTS } from "../../src/constants";
import { hashJoinSecret, randomBase64Url } from "@41d/sdk/crypto";
import { RendezvousSession } from "../../src/rendezvous";
import type { RoomMessage } from "../../src/types";

const INVITE_TTL_MS = 10 * 60 * 1000;

/** Create a mock DurableObjectState with in-memory storage. */
export function createMockState(): DurableObjectState {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { storage.set(key, value); },
      delete: async (key: string) => storage.delete(key),
      deleteAll: async () => storage.clear(),
      list: async () => new Map(),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      sync: async () => {},
      transaction: async <T>(fn: () => Promise<T>) => fn(),
    },
    id: { toString: () => "test-do" },
    waitUntil: async () => {},
    blockConcurrencyWhile: async () => {},
  } as unknown as DurableObjectState;
}

export function createMockEnv(): { RENDEZVOUS: DurableObjectNamespace } {
  return { RENDEZVOUS: {} as DurableObjectNamespace };
}

export interface RoomOpts {
  roomId?: string;
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
  firstMessage?: Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  initialBoard?: Record<string, unknown>;
}

/** Bootstrap a room. Returns the session, the invite/secret, and the room path for making auth'd requests. */
export async function bootstrapRoom(opts: RoomOpts = {}): Promise<RoomFixture> {
  const session = new RendezvousSession(createMockState(), createMockEnv());
  const roomId = opts.roomId ?? randomBase64Url(16);
  const joinSecret = randomBase64Url(32);
  const secretHash = await hashJoinSecret(roomId, joinSecret);

  const res = await session.fetch(new Request("https://rendezvous.internal/__init", {
    method: "POST",
    body: JSON.stringify({
      roomId,
      secretHash,
      expiresAt: Date.now() + INVITE_TTL_MS,
      phase: "waiting" as const,
      hostId: opts.hostId ?? "host",
      roomName: opts.roomName ?? "test room",
      maxParticipants: opts.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
      ...(opts.firstMessage ? { firstMessage: opts.firstMessage } : {}),
      ...(opts.boardSchema ? { boardSchema: opts.boardSchema } : {}),
      ...(opts.initialBoard ? { initialBoard: opts.initialBoard } : {}),
    }),
    headers: { "content-type": "application/json" },
  }));

  if (!res.ok) throw new Error(`bootstrapRoom failed: ${res.status}`);
  return { session, roomId, joinSecret, roomPath: `/r/${roomId}` };
}

export interface RoomFixture {
  session: RendezvousSession;
  roomId: string;
  joinSecret: string;
  roomPath: string;
}

export function authHeaders(secret: string, participantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (participantId) headers["x-participant-id"] = participantId;
  return headers;
}

export async function roomRequest(fixture: RoomFixture, path = "", init?: RequestInit): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}${path}`, init));
}

export async function deleteParticipant(fixture: RoomFixture, targetId: string, actorId?: string): Promise<Response> {
  return roomRequest(fixture, `/participants/${encodeURIComponent(targetId)}`, {
    method: "DELETE",
    headers: authHeaders(fixture.joinSecret, actorId),
  });
}

export async function closeRoom(fixture: RoomFixture): Promise<Response> {
  return roomRequest(fixture, "", {
    method: "DELETE",
    headers: authHeaders(fixture.joinSecret, "host"),
  });
}

export async function getRoomJson<T>(fixture: RoomFixture, path: string): Promise<T> {
  const res = await roomRequest(fixture, path, { headers: authHeaders(fixture.joinSecret) });
  expect(res.status).toBe(200);
  return await res.json() as T;
}

export async function joinParticipant(fixture: RoomFixture, participantId: string): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}/participants/${encodeURIComponent(participantId)}`, {
    method: "PUT",
    headers: { ...authHeaders(fixture.joinSecret), "content-type": "application/json" },
  }));
}

export function encryptedPayload(body: unknown): { encrypted_payload: string } {
  return { encrypted_payload: JSON.stringify(body) };
}

export function decodedPayload<T>(body: unknown): T {
  return JSON.parse((body as { encrypted_payload: string }).encrypted_payload) as T;
}

export async function sendMessage(fixture: RoomFixture, participantId: string, to: string, body: unknown): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}`, {
    method: "POST",
    headers: { ...authHeaders(fixture.joinSecret, participantId), "content-type": "application/json" },
    body: JSON.stringify({ to, body: encryptedPayload(body) }),
  }));
}

export async function readMessages(fixture: RoomFixture, participantId: string, after = 0): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}?after=${after}`, {
    headers: authHeaders(fixture.joinSecret, participantId),
  }));
}

// Re-export vitest helpers for convenience
import { expect } from "vitest";
export type { RoomMessage } from "../../src/types";
