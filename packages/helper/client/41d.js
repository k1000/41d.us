#!/usr/bin/env node
/* 41d.us tiny encrypted client. No npm deps.
   Create:   curl -fsSL https://41d.us/client/41d.js | node - create https://41d.us '{"host_id":"agent-a"}' > docs-review.json
   Join:     curl -fsSL https://41d.us/client/41d.js | node - join invitation.json agent-b
   Doctor:   curl -fsSL https://41d.us/client/41d.js | node - doctor invitation.json agent-b
   Send:     curl -fsSL https://41d.us/client/41d.js | node - send invitation.json agent-b all '{"text":"hello"}'
   Read:     curl -fsSL https://41d.us/client/41d.js | node - read invitation.json agent-b
   Full:     curl -fsSL https://41d.us/client/41d.js | node - send "$ROOM_URL" "$JOIN_SECRET" "$ME" all '{"text":"hello"}'
   Env:      ROOM_URL=... JOIN_SECRET=... ME=... ./41d send all '{"text":"hello"}'
   Commands: create, join, send, read, inbox, doctor
*/
const fs = await import('node:fs/promises');
const { webcrypto } = await import('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const rawArgs = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== '--');
const cmd = rawArgs[0];
if (cmd === 'create') {
  const baseUrl = (rawArgs[1] || process.env.BASE_URL || 'https://41d.us').replace(/\/$/, '');
  const options = rawArgs[2] ? JSON.parse(rawArgs[2]) : {};
  const r = await fetch(baseUrl + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options) });
  const text = await r.text();
  if (!r.ok) die(text);
  console.log(text);
  process.exit(0);
}
const resolved = await resolveRoomArgs(rawArgs);
const roomUrl = resolved.roomUrl;
const joinSecret = resolved.joinSecret;
const me = resolved.me;
const rest = resolved.rest;
if (!cmd || !roomUrl || !joinSecret || !me) die('usage: 41d <create|join|send|read|doctor> [invitation.json me | room_url join_secret me] [to] [json_body]\nTip: set ROOM_URL, JOIN_SECRET, and ME to omit repeated args.');
const headers = { authorization: 'Bearer ' + joinSecret, 'x-participant-id': me };
const keyFile = '.41d-' + new URL(roomUrl).pathname.replace(/[^a-zA-Z0-9_-]/g, '_') + '-' + me.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';

function die(message) { console.error(message); process.exit(1); }
async function resolveRoomArgs(args) {
  if (usesEnvRoom(args)) return envRoomArgs(args);
  if (isRoomUrl(args[1])) return urlRoomArgs(args);
  if (args[1]) return inviteRoomArgs(args);
  return envRoomArgs(args);
}
function usesEnvRoom(args) { return hasEnvRoom() && isEnvShape(args[0], args.length); }
function hasEnvRoom() { return process.env.ROOM_URL && process.env.JOIN_SECRET && process.env.ME; }
function isEnvShape(command, argc) { return (command === 'send' && argc <= 3) || (['join', 'read', 'inbox', 'doctor'].includes(command) && argc === 1); }
function isRoomUrl(value) { return value && /^https?:/.test(value); }
function envRoomArgs(args) { return { roomUrl: process.env.ROOM_URL, joinSecret: process.env.JOIN_SECRET, me: process.env.ME, rest: args.slice(1) }; }
function urlRoomArgs(args) { return { roomUrl: args[1], joinSecret: args[2], me: args[3], rest: args.slice(4) }; }
async function inviteRoomArgs(args) {
  const invite = await loadInvite(args[1]);
  return { roomUrl: invite.room_url, joinSecret: invite.join_secret, me: args[2], rest: args.slice(3) };
}
async function loadInvite(ref) {
  const invite = JSON.parse(await inviteText(ref));
  const roomUrl = inviteUrl(invite);
  if (!roomUrl || !invite.join_secret) die('invite must include access (or room_url) and join_secret');
  return { ...invite, room_url: roomUrl };
}
async function inviteText(ref) { return ref.trim().startsWith('{') ? ref : fs.readFile(ref, 'utf8'); }
function inviteUrl(invite) { return invite.access || invite.follow || invite.room_url; }
function b64u(bytes) { return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function unb64u(value) { return new Uint8Array(Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')); }
async function aesEncrypt(key, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)); return { ciphertext: b64u(new Uint8Array(ciphertext)), iv: b64u(iv) }; }
async function aesDecryptBytes(key, ciphertext, iv) { return subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, key, unb64u(ciphertext)); }
async function aesDecrypt(key, ciphertext, iv) { return dec.decode(await aesDecryptBytes(key, ciphertext, iv)); }
async function makeKeys() { return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']); }
async function exportPublic(key) { return b64u(new Uint8Array(await subtle.exportKey('raw', key))); }
async function importPublic(raw) { if (typeof raw === 'object' && raw !== null) return subtle.importKey('jwk', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []); return subtle.importKey('raw', unb64u(raw), { name: 'ECDH', namedCurve: 'P-256' }, true, []); }
async function derive(privateKey, publicKey) { return subtle.deriveKey({ name: 'ECDH', public: publicKey }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
async function loadState() {
  try {
    const state = JSON.parse(await fs.readFile(keyFile, 'utf8'));
    return { ...state, created: false, keyPair: { privateKey: await subtle.importKey('jwk', state.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']), publicKey: await subtle.importKey('jwk', state.publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []) } };
  } catch {
    const keyPair = await makeKeys();
    const state = { privateJwk: await subtle.exportKey('jwk', keyPair.privateKey), publicJwk: await subtle.exportKey('jwk', keyPair.publicKey), peers: {}, created: true, keyPair };
    await saveState(state);
    return state;
  }
}
async function saveState(state) { await fs.writeFile(keyFile, JSON.stringify({ privateJwk: state.privateJwk, publicJwk: state.publicJwk, peers: state.peers }, null, 2)); }
async function requestJson(url, init = {}) { const r = await fetch(url, init); const text = await r.text(); let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; } return { ok: r.ok, status: r.status, body }; }
async function announce(state) { return post({ to: 'all', intent: 'key.exchange', body: { public_key: await exportPublic(state.keyPair.publicKey) } }); }
async function post(payload) { const r = await requestJson(roomUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload) }); if (!r.ok) die(formatErrorBody(r.body)); return r.body; }
async function syncKeys(state) {
  const messages = await readAllMessages();
  rememberPeerKeys(state, messages);
  await saveState(state);
  return messages;
}
async function readAllMessages() {
  const r = await requestJson(roomUrl + '/?view=all&include_self=true', { headers });
  if (!r.ok) die(formatErrorBody(r.body));
  return r.body.messages || [];
}
function rememberPeerKeys(state, messages) {
  for (const m of messages.filter(isPeerKeyExchange)) state.peers[m.from] = m.body.public_key;
}
function isPeerKeyExchange(m) { return m.intent === 'key.exchange' && m.from !== me && m.body?.public_key; }
function formatErrorBody(body) { return typeof body === 'string' ? body : JSON.stringify(body, null, 2); }
async function shared(state, id) { const raw = id === me ? await exportPublic(state.keyPair.publicKey) : state.peers[id]; if (!raw) die('no public key for ' + id + '; ask them to join/announce, then run read or send again'); return derive(state.keyPair.privateKey, await importPublic(raw)); }
async function wrapKey(messageKey, sharedKey) { const raw = await subtle.exportKey('raw', messageKey); const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, raw); return { encrypted_key: b64u(new Uint8Array(encrypted)), iv: b64u(iv) }; }
async function encryptBody(state, recipient, body) {
  const recipients = recipientIds(recipient, state);
  const plaintext = JSON.stringify(body);
  if (canUseDirectEncryption(recipients)) return directEncryptedBody(state, recipients[0], plaintext);
  return groupEncryptedBody(state, recipients, plaintext);
}
function recipientIds(recipient, state) { return recipient === 'all' ? Object.keys(state.peers) : [recipient]; }
function canUseDirectEncryption(recipients) { return recipients.length === 1 && recipients[0] !== me; }
async function directEncryptedBody(state, recipient, plaintext) { return { encrypted: true, ...await aesEncrypt(await shared(state, recipient), plaintext) }; }
async function groupEncryptedBody(state, recipients, plaintext) {
  const messageKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const encrypted = await aesEncrypt(messageKey, plaintext);
  return { encrypted: true, ...encrypted, keys: await wrappedKeys(state, recipients, messageKey) };
}
async function wrappedKeys(state, recipients, messageKey) {
  const keys = {};
  for (const id of new Set([...recipients, me])) keys[id] = await wrapKey(messageKey, await shared(state, id));
  return keys;
}
async function decryptBody(state, msg) {
  const b = msg.body;
  if (!b?.encrypted) return b;
  try { return JSON.parse(await decryptEncryptedBody(state, msg)); }
  catch { return b; }
}
async function decryptEncryptedBody(state, msg) {
  const b = msg.body;
  if (!b.keys?.[me]) return aesDecrypt(await shared(state, msg.from), b.ciphertext, b.iv);
  const key = await unwrapMessageKey(state, msg.from, b.keys[me]);
  return aesDecrypt(key, b.ciphertext, b.iv);
}
async function unwrapMessageKey(state, from, wrapped) {
  const keyRaw = await aesDecryptBytes(await shared(state, from), wrapped.encrypted_key, wrapped.iv);
  return subtle.importKey('raw', keyRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function joined() {
  const r = await requestJson(roomUrl + '/participants', { headers: { authorization: 'Bearer ' + joinSecret } });
  if (!r.ok) return { ok: false, status: r.status, participants: [] };
  const participants = r.body.participants || [];
  return { ok: participants.some((p) => p.id === me), status: r.status, participants };
}
async function doctorMessages(state, joinedOk) {
  if (!joinedOk) return [];
  await announce(state).catch(() => undefined);
  return syncKeys(state);
}
async function encryptedStats(state, messages) {
  const stats = { encrypted: 0, decryptable: 0 };
  for (const m of messages.filter((msg) => msg.body?.encrypted)) {
    stats.encrypted++;
    const decrypted = await decryptBody(state, m);
    if (!decrypted?.encrypted) stats.decryptable++;
  }
  return stats;
}
function doctorReport(state, joinedResult, messages, stats) {
  return {
    ok: joinedResult.ok,
    participant_id: me,
    joined: joinedResult.ok,
    key_file: keyFile,
    local_key_created: state.created,
    key_announced: messages.some((m) => m.from === me && m.intent === 'key.exchange'),
    known_peers: Object.keys(state.peers),
    encrypted_messages_seen: stats.encrypted,
    encrypted_messages_decryptable: stats.decryptable,
    key_note: 'Reuse this key file from the same directory to retain your ECDH keypair across sessions: ' + keyFile,
  };
}

/**
 * Command dispatch: each handler receives (state, roomUrl, joinSecret, me, rest, headers, keyFile).
 */
const COMMANDS = {
  async join(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    const r = await requestJson(roomUrl + '/participants/' + encodeURIComponent(me), { method: 'PUT', headers: { authorization: 'Bearer ' + joinSecret, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'free', status: 'joined with encrypted tiny client' }) });
    if (!r.ok && r.status !== 409) die(formatErrorBody(r.body));
    await announce(state);
    console.log(JSON.stringify({ ok: true, participant_id: me, key_file: keyFile, joined: r.status !== 409, key_warning: 'Save this key file to decrypt messages in future sessions: ' + keyFile }, null, 2));
  },
  async send(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    const [to, bodyJson] = rest;
    if (!to || !bodyJson) die('send needs: <to> <json_body>');
    await syncKeys(state);
    await announce(state);
    console.log(JSON.stringify(await post({ to, body: await encryptBody(state, to, JSON.parse(bodyJson)) }), null, 2));
  },
  async read(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    const messages = await syncKeys(state);
    const out = [];
    for (const m of messages) out.push({ ...m, body: await decryptBody(state, m) });
    console.log(JSON.stringify(out, null, 2));
  },
  async doctor(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    const j = await joined();
    const messages = await doctorMessages(state, j.ok);
    const stats = await encryptedStats(state, messages);
    console.log(JSON.stringify(doctorReport(state, j, messages, stats), null, 2));
  },
};

const handler = COMMANDS[cmd];
if (!handler) die('unknown command: ' + cmd + '. Usage: create|join|send|read|inbox|doctor');

const state = await loadState();
await handler(state, { roomUrl, joinSecret, me, rest, headers, keyFile });
