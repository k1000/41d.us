import type { RoomMessage } from "../types";
import { visibleTo } from "./messages";

const SSE_HEARTBEAT_MS = 25_000;
const ENCODER = new TextEncoder();

interface EventSubscriber {
  participantId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  includeSelf: boolean;
}

export class RoomEvents {
  private readonly subscribers = new Map<string, EventSubscriber>();

  subscribe(participantId: string, includeSelf: boolean, lastSeq: number): Response {
    let interval: ReturnType<typeof setInterval> | undefined;
    let subscriberId = "";
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriberId = crypto.randomUUID();
        this.subscribers.set(subscriberId, { participantId, controller, includeSelf });
        enqueueSse(controller, "ready", { participant_id: participantId, last_seq: lastSeq });
        interval = setInterval(() => enqueueSse(controller, "ping", { ts: new Date().toISOString() }), SSE_HEARTBEAT_MS);
      },
      cancel: () => {
        if (interval) clearInterval(interval);
        this.subscribers.delete(subscriberId);
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
    for (const [id, subscriber] of this.subscribers) {
      if (!subscriber.includeSelf && message.from === subscriber.participantId) continue;
      if (!visibleTo(message, subscriber.participantId)) continue;
      this.enqueueOrDelete(id, subscriber.controller, "changed", { last_seq: lastSeq });
    }
  }

  notifyBoard(keys: string | string[], updatedBy: string): void {
    for (const [id, subscriber] of this.subscribers) {
      this.enqueueOrDelete(id, subscriber.controller, "board", { keys: Array.isArray(keys) ? keys : [keys], updated_by: updatedBy });
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
  controller.enqueue(ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}
