import type { RoomMessage } from "../types";
import { visibleTo } from "./messages";

const SSE_HEARTBEAT_MS = 25_000;
const SSE_SWEEP_INTERVAL = 50;
const ENCODER = new TextEncoder();

interface EventSubscriber {
  participantId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  includeSelf: boolean;
}

export interface RoomEventBus {
  subscribe(participantId: string, includeSelf: boolean, lastSeq: number): Response;
  notifyMessage(message: RoomMessage, lastSeq: number): void;
  notifyBoard(keys: string | string[], updatedBy: string): void;
}

export class RoomEvents implements RoomEventBus {
  private readonly subscribers = new Map<string, EventSubscriber>();
  private notificationCount = 0;

  subscribe(participantId: string, includeSelf: boolean, lastSeq: number): Response {
    let interval: ReturnType<typeof setInterval> | undefined;
    let subscriberId = "";
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriberId = crypto.randomUUID();
        this.subscribers.set(subscriberId, { participantId, controller, includeSelf });
        enqueueSse(controller, "ready", { participant_id: participantId, last_seq: lastSeq });
        interval = setInterval(() => {
          try {
            enqueueSse(controller, "ping", { ts: new Date().toISOString() });
          } catch {
            if (interval) clearInterval(interval);
            if (subscriberId) this.subscribers.delete(subscriberId);
          }
        }, SSE_HEARTBEAT_MS);
      },
      cancel: () => {
        if (interval) clearInterval(interval);
        if (subscriberId) this.subscribers.delete(subscriberId);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  notifyMessage(message: RoomMessage, lastSeq: number): void {
    this.maybeSweep();
    for (const [id, subscriber] of this.subscribers) {
      if (!subscriber.includeSelf && message.from === subscriber.participantId) continue;
      if (!visibleTo(message, subscriber.participantId)) continue;
      this.enqueueOrDelete(id, subscriber.controller, "changed", { last_seq: lastSeq });
    }
  }

  notifyBoard(keys: string | string[], updatedBy: string): void {
    this.maybeSweep();
    for (const [id, subscriber] of this.subscribers) {
      this.enqueueOrDelete(id, subscriber.controller, "board", { keys: Array.isArray(keys) ? keys : [keys], updated_by: updatedBy });
    }
  }

  /**
   * Periodically sweep stale subscribers whose controllers silently
   * disconnected without triggering the cancel callback.
   */
  private maybeSweep(): void {
    if (++this.notificationCount % SSE_SWEEP_INTERVAL !== 0) return;
    for (const [id, subscriber] of this.subscribers) {
      try {
        enqueueSse(subscriber.controller, "ping", { ts: new Date().toISOString() });
      } catch {
        this.subscribers.delete(id);
      }
    }
  }

  private enqueueOrDelete(id: string, controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void {
    try {
      enqueueSse(controller, event, data);
    } catch {
      this.subscribers.delete(id);
    }
  }
}

function enqueueSse(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void {
  const json = JSON.stringify(data);
  const lines = json.split("\n").map((line) => `data: ${line}`).join("\n");
  controller.enqueue(ENCODER.encode(`event: ${event}\n${lines}\n\n`));
}
