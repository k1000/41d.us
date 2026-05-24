export type Recipient = "all" | string | string[];

export interface RoomMessage {
  id: string;
  seq: number;
  from: string;
  to: Recipient;
  reply_to: string | null;
  intent: string;
  priority: string;
  body: unknown;
  created_at: string;
}
