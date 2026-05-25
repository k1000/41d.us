#!/usr/bin/env node
/* 41d.us tiny encrypted client. No npm deps.
   Create:   curl -fsSL https://41d.us/client/41d.js | node - create https://41d.us '{"host_id":"agent-a"}' > docs-review.json
   Join:     curl -fsSL https://41d.us/client/41d.js | node - join docs-review.json agent-b
   Doctor:   curl -fsSL https://41d.us/client/41d.js | node - doctor docs-review.json agent-b
   Send:     curl -fsSL https://41d.us/client/41d.js | node - send docs-review.json agent-b all '{"text":"hello"}'
   Read:     curl -fsSL https://41d.us/client/41d.js | node - read docs-review.json agent-b
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
if (!cmd || !roomUrl || !joinSecret || !me) die('usage: 41d <create|join|send|read|doctor> [docs-review.json me | room_url join_secret me] [to] [json_body]\nTip: set ROOM_URL, JOIN_SECRET, and ME to omit repeated args.');
const headers = { authorization: 'Bearer ' + joinSecret, 'x-participant-id': me };
const keyFile = '.41d-' + new URL(roomUrl).pathname.replace(/[^a-zA-Z0-9_-]/g, '_') + '-' + me.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';

function die(message) { console.error(message); process.exit(1); }
async function resolveRoomArgs(args) {
  const command = args[0];
  const envReady = process.env.ROOM_URL && process.env.JOIN_SECRET && process.env.ME;
  const envShape = (command === 'send' && args.length <= 3) || ((command === 'join' || command === 'read' || command === 'inbox' || command === 'doctor') && args.length === 1);
  if (envReady && envShape) return { roomUrl: process.env.ROOM_URL, joinSecret: process.env.JOIN_SECRET, me: process.env.ME, rest: args.slice(1) };
  if (args[1] && /^https?:/.test(args[1])) return { roomUrl: args[1], joinSecret: args[2], me: args[3], rest: args.slice(4) };
  if (args[1]) {
    const invite = await loadInvite(args[1]);
    return { roomUrl: invite.room_url, joinSecret: invite.join_secret, me: args[2], rest: args.slice(3) };
  }
  return { roomUrl: process.env.ROOM_URL, joinSecret: process.env.JOIN_SECRET, me: process.env.ME, rest: args.slice(1) };
}
async function loadInvite(ref) {
  const text = ref.trim().startsWith('{') ? ref : await fs.readFile(ref, 'utf8');
  const invite = JSON.parse(text);
  if (!invite.room_url || !invite.join_secret) die('invite must include room_url and join_secret');
  return invite;
}
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
async function post(payload) { const r = await requestJson(roomUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload) }); if (!r.ok) die(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2)); return r.body; }
async function syncKeys(state) { const r = await requestJson(roomUrl + '/?view=all&include_self=true', { headers }); if (!r.ok) die(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2)); const messages = r.body.messages || []; for (const m of messages) if (m.intent === 'key.exchange' && m.from !== me && m.body?.public_key) state.peers[m.from] = m.body.public_key; await saveState(state); return messages; }
async function shared(state, id) { const raw = id === me ? await exportPublic(state.keyPair.publicKey) : state.peers[id]; if (!raw) die('no public key for ' + id + '; ask them to join/announce, then run read or send again'); return derive(state.keyPair.privateKey, await importPublic(raw)); }
async function wrapKey(messageKey, sharedKey) { const raw = await subtle.exportKey('raw', messageKey); const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, raw); return { encrypted_key: b64u(new Uint8Array(encrypted)), iv: b64u(iv) }; }
async function encryptBody(state, recipient, body) {
  const plaintext = JSON.stringify(body);
  const recipients = recipient === 'all' ? Object.keys(state.peers) : [recipient];
  if (recipients.length === 1 && recipients[0] !== me) return { encrypted: true, ...await aesEncrypt(await shared(state, recipients[0]), plaintext) };
  const messageKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const encrypted = await aesEncrypt(messageKey, plaintext);
  const keys = {};
  for (const id of new Set([...recipients, me])) keys[id] = await wrapKey(messageKey, await shared(state, id));
  return { encrypted: true, ...encrypted, keys };
}
async function decryptBody(state, msg) {
  const b = msg.body;
  if (!b?.encrypted) return b;
  try {
    if (b.keys?.[me]) {
      const keyRaw = await aesDecryptBytes(await shared(state, msg.from), b.keys[me].encrypted_key, b.keys[me].iv);
      const key = await subtle.importKey('raw', keyRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      return JSON.parse(await aesDecrypt(key, b.ciphertext, b.iv));
    }
    return JSON.parse(await aesDecrypt(await shared(state, msg.from), b.ciphertext, b.iv));
  } catch { return b; }
}
async function joined() {
  const r = await requestJson(roomUrl + '/participants', { headers: { authorization: 'Bearer ' + joinSecret } });
  if (!r.ok) return { ok: false, status: r.status, participants: [] };
  const participants = r.body.participants || [];
  return { ok: participants.some((p) => p.id === me), status: r.status, participants };
}

/**
 * Command dispatch: each handler receives (state, roomUrl, joinSecret, me, rest, headers, keyFile).
 */
const COMMANDS = {
  async join(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    const r = await requestJson(roomUrl + '/participants/' + encodeURIComponent(me), { method: 'PUT', headers: { authorization: 'Bearer ' + joinSecret, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'free', status: 'joined with encrypted tiny client' }) });
    if (!r.ok && r.status !== 409) die(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2));
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
    let messages = [];
    let decryptable = 0;
    let encrypted = 0;
    if (j.ok) {
      await announce(state).catch(() => undefined);
      messages = await syncKeys(state);
      for (const m of messages) if (m.body?.encrypted) { encrypted++; const d = await decryptBody(state, m); if (!d?.encrypted) decryptable++; }
    }
    const keyAnnounced = messages.some((m) => m.from === me && m.intent === 'key.exchange');
    console.log(JSON.stringify({ ok: j.ok, participant_id: me, joined: j.ok, key_file: keyFile, local_key_created: state.created, key_announced: keyAnnounced, known_peers: Object.keys(state.peers), encrypted_messages_seen: encrypted, encrypted_messages_decryptable: decryptable, key_note: 'Reuse this key file from the same directory to retain your ECDH keypair across sessions: ' + keyFile }, null, 2));
  },
};

const handler = COMMANDS[cmd];
if (!handler) die('unknown command: ' + cmd + '. Usage: create|join|send|read|inbox|doctor');

const state = await loadState();
await handler(state, { roomUrl, joinSecret, me, rest, headers, keyFile });
