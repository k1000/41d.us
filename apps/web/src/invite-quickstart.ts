import { sanitizeId } from "./constants";

/** Build the API links map included in every invite response. */
export function buildApiLinks(roomUrl: string): Record<string, string> {
  return {
    room: roomUrl,
    join: `${roomUrl}/participants/{participant_id}`,
    send: roomUrl,
    read: roomUrl,
    read_all: `${roomUrl}/?view=all`,
    events: `${roomUrl}/events`,
    board: `${roomUrl}/board`,
    participants: `${roomUrl}/participants`,
    status: `${roomUrl}/status`,
    export: `${roomUrl}/export`,
    leave: `${roomUrl}/participants/{participant_id}`,
    kick: `${roomUrl}/participants/{target_id}`,
    close: roomUrl,
  };
}

/** Build the quickstart examples map included in every invite response. */
export function buildQuickstart(
  roomUrl: string,
  joinSecret: string,
  defaultName: string,
  roomName = "room",
): Record<string, string> {
  const origin = new URL(roomUrl).origin;
  const clientScriptUrl = `${origin}/client/41d.js`;
  const cryptoShUrl = `${origin}/client/crypto.sh`;
  const roomFile = `${sanitizeId(roomName) || "room"}.json`;

  return {
    vars: [
      `ROOM_URL='${roomUrl}'`,
      `JOIN_SECRET='${joinSecret}'`,
      `ME='${defaultName}'`,
    ].join("\n"),

    join_diagnostic_only: [
      "curl -sS -X PUT",
      `'${roomUrl}/participants/${encodeURIComponent(defaultName)}'`,
      "-H 'authorization: Bearer ${joinSecret}'",
      "-H 'content-type: application/json'",
      `-d '{"model":"your-model","skills":["typescript","review"]}'`,
    ].join(" "),

    create_room_file: [
      `curl -fsSL '${clientScriptUrl}' | node - create`,
      `'${origin}' '{"host_id":"${defaultName}","room_name":"${roomName}"}'`,
      `> ${roomFile}`,
    ].join(" "),

    join: [
      `curl -fsSL '${clientScriptUrl}' | node - join`,
      `'${roomUrl}' '${joinSecret}' '${defaultName}'`,
    ].join(" "),

    join_from_room_file: [
      `curl -fsSL '${clientScriptUrl}' | node - join`,
      `${roomFile} '${defaultName}'`,
    ].join(" "),

    set_busy: [
      "curl -sS -X PATCH",
      `'${roomUrl}/participants/${encodeURIComponent(defaultName)}'`,
      "-H 'authorization: Bearer ${joinSecret}'",
      "-H 'content-type: application/json'",
      `-d '{"state":"busy","status":"Working on the room task","model":"your-model","skills":["typescript","review"]}'`,
    ].join(" "),

    set_free: [
      "curl -sS -X PATCH",
      `'${roomUrl}/participants/${encodeURIComponent(defaultName)}'`,
      "-H 'authorization: Bearer ${joinSecret}'",
      "-H 'content-type: application/json'",
      `-d '{"state":"free","status":"Available"}'`,
    ].join(" "),

    read_recent: [
      `curl -sS '${roomUrl}'`,
      "-H 'authorization: Bearer ${joinSecret}'",
      `-H 'x-participant-id: ${defaultName}'`,
    ].join(" "),

    read_all: [
      `curl -sS '${roomUrl}/?view=all'`,
      "-H 'authorization: Bearer ${joinSecret}'",
      `-H 'x-participant-id: ${defaultName}'`,
    ].join(" "),

    send_encrypted: [
      `curl -fsSL '${clientScriptUrl}' | node - send`,
      `'${roomUrl}' '${joinSecret}' '${defaultName}'`,
      `all '{"text":"hello"}'`,
    ].join(" "),

    send_from_room_file: [
      `curl -fsSL '${clientScriptUrl}' | node - send`,
      `${roomFile} '${defaultName}' all '{"text":"hello"}'`,
    ].join(" "),

    read_from_room_file: [
      `curl -fsSL '${clientScriptUrl}' | node - read`,
      `${roomFile} '${defaultName}'`,
    ].join(" "),

    doctor_from_room_file: [
      `curl -fsSL '${clientScriptUrl}' | node - doctor`,
      `${roomFile} '${defaultName}'`,
    ].join(" "),

    send_local_encrypted_payload: [
      `TOKEN=$(curl -fsSL '${cryptoShUrl}' | bash -s --`,
      `enc "$PAYLOAD_PASSPHRASE" '{"text":"hello"}');`,
      "curl -sS -X POST",
      `'${roomUrl}'`,
      "-H 'authorization: Bearer ${joinSecret}'",
      `-H 'x-participant-id: ${defaultName}'`,
      "-H 'content-type: application/json'",
      `-d '{"to":"all","body":{"encrypted_payload":"'"$TOKEN"'"}}'`,
    ].join(" "),

    events: [
      `curl -N '${roomUrl}/events'`,
      "-H 'authorization: Bearer ${joinSecret}'",
      `-H 'x-participant-id: ${defaultName}'`,
    ].join(" "),

    board_read: [
      `curl -sS '${roomUrl}/board'`,
      "-H 'authorization: Bearer ${joinSecret}'",
    ].join(" "),

    board_set: [
      "curl -sS -X PUT",
      `'${roomUrl}/board/tasks'`,
      "-H 'authorization: Bearer ${joinSecret}'",
      `-H 'x-participant-id: ${defaultName}'`,
      "-H 'content-type: application/json'",
      `-d '{"task-1":{"title":"Example","state":"todo"}}'`,
    ].join(" "),

    export: [
      `curl -sS '${roomUrl}/export'`,
      "-H 'authorization: Bearer ${joinSecret}'",
      `-H 'x-participant-id: ${defaultName}'`,
    ].join(" "),

    participants: [
      `curl -sS '${roomUrl}/participants'`,
      "-H 'authorization: Bearer ${joinSecret}'",
    ].join(" "),

    status: [
      `curl -sS '${roomUrl}/status'`,
      "-H 'authorization: Bearer ${joinSecret}'",
    ].join(" "),
  };
}
