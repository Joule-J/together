import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const ROOM_TTL_MS = 1000 * 60 * 60 * 4;
const HEARTBEAT_TIMEOUT_MS = 1000 * 30;
const CHAT_LIMIT = 50;

const rooms = new Map();
const clients = new Map();

function nowIso() {
  return new Date().toISOString();
}

function normalizeNickname(input) {
  const trimmed = String(input ?? "").trim().slice(0, 32);
  return trimmed || `Guest-${Math.floor(Math.random() * 900 + 100)}`;
}

function generateRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(id) ? generateRoomId() : id;
}

function createRoom(sessionId, nickname) {
  const roomId = generateRoomId();
  const participant = {
    sessionId,
    nickname,
    role: "host",
    presence: "online",
    joinedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };

  const room = {
    roomId,
    hostSessionId: sessionId,
    participants: new Map([[sessionId, participant]]),
    currentMediaState: null,
    chatMessages: [],
    updatedAt: Date.now(),
  };

  rooms.set(roomId, room);
  return room;
}

function serializeParticipant(participant) {
  return {
    sessionId: participant.sessionId,
    nickname: participant.nickname,
    role: participant.role,
    presence: participant.presence,
  };
}

function serializeRoomState(room) {
  return {
    roomId: room.roomId,
    hostSessionId: room.hostSessionId,
    participants: Array.from(room.participants.values()).map(serializeParticipant),
    mediaState: room.currentMediaState,
    chatMessages: room.chatMessages,
  };
}

function send(ws, type, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ type, payload }));
}

function broadcastRoom(room, type, payload) {
  for (const participant of room.participants.values()) {
    const client = clients.get(participant.sessionId);
    if (client?.ws) {
      send(client.ws, type, payload);
    }
  }
}

function updatePresence(room) {
  broadcastRoom(room, "presence:update", {
    participants: Array.from(room.participants.values()).map(serializeParticipant),
    hostSessionId: room.hostSessionId,
  });
}

function ensureHost(room) {
  const host = room.participants.get(room.hostSessionId);
  if (host && host.presence === "online") {
    return;
  }

  const replacement = Array.from(room.participants.values())
    .filter((participant) => participant.presence === "online")
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];

  if (!replacement) {
    return;
  }

  room.hostSessionId = replacement.sessionId;
  for (const participant of room.participants.values()) {
    participant.role = participant.sessionId === replacement.sessionId ? "host" : "viewer";
  }
}

function leaveRoom(sessionId) {
  const client = clients.get(sessionId);
  if (!client?.roomId) {
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room) {
    client.roomId = null;
    return;
  }

  room.participants.delete(sessionId);
  client.roomId = null;
  room.updatedAt = Date.now();

  if (room.participants.size === 0) {
    rooms.delete(room.roomId);
    return;
  }

  ensureHost(room);
  updatePresence(room);
  broadcastRoom(room, "room:state", serializeRoomState(room));
}

function joinRoom(sessionId, roomId, nickname) {
  const room = rooms.get(roomId);
  if (!room) {
    return { error: { code: "ROOM_NOT_FOUND", message: "Room not found." } };
  }

  const existing = room.participants.get(sessionId);
  const participant = existing ?? {
    sessionId,
    nickname,
    role: "viewer",
    presence: "online",
    joinedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };

  participant.nickname = nickname;
  participant.presence = "online";
  participant.lastHeartbeat = Date.now();
  participant.role = sessionId === room.hostSessionId ? "host" : "viewer";

  room.participants.set(sessionId, participant);
  room.updatedAt = Date.now();
  return { room };
}

function handleRoomCreate(ws, sessionId, payload) {
  leaveRoom(sessionId);
  const nickname = normalizeNickname(payload?.nickname);
  const room = createRoom(sessionId, nickname);
  clients.get(sessionId).roomId = room.roomId;
  send(ws, "room:state", serializeRoomState(room));
  updatePresence(room);
}

function handleRoomJoin(ws, sessionId, payload) {
  leaveRoom(sessionId);
  const roomId = String(payload?.roomId ?? "").trim().toUpperCase();
  const nickname = normalizeNickname(payload?.nickname);
  const result = joinRoom(sessionId, roomId, nickname);

  if (result.error) {
    send(ws, "sync:error", result.error);
    return;
  }

  clients.get(sessionId).roomId = roomId;
  send(ws, "room:state", serializeRoomState(result.room));
  updatePresence(result.room);
  broadcastRoom(result.room, "room:state", serializeRoomState(result.room));
}

function handleMediaEvent(ws, sessionId, payload) {
  const roomId = clients.get(sessionId)?.roomId;
  const room = rooms.get(roomId);

  if (!room) {
    send(ws, "sync:error", { code: "ROOM_REQUIRED", message: "Join a room first." });
    return;
  }

  if (room.hostSessionId !== sessionId) {
    send(ws, "sync:error", { code: "HOST_ONLY", message: "Only the host can control sync." });
    return;
  }

  const mediaState = {
    fingerprint: String(payload?.fingerprint ?? ""),
    currentTime: Number(payload?.currentTime ?? 0),
    paused: Boolean(payload?.paused),
    playbackRate: Number(payload?.playbackRate ?? 1),
    updatedAt: nowIso(),
    seq: Number(payload?.seq ?? 0),
    eventType: String(payload?.type ?? "sync"),
  };

  room.currentMediaState = mediaState;
  room.updatedAt = Date.now();

  broadcastRoom(room, "media:apply", {
    roomId: room.roomId,
    seq: mediaState.seq,
    currentTime: mediaState.currentTime,
    paused: mediaState.paused,
    playbackRate: mediaState.playbackRate,
    fingerprint: mediaState.fingerprint,
    serverTimestamp: Date.now(),
    eventType: mediaState.eventType,
    hostSessionId: room.hostSessionId,
  });
}

function handleChatSend(ws, sessionId, payload) {
  const roomId = clients.get(sessionId)?.roomId;
  const room = rooms.get(roomId);

  if (!room) {
    send(ws, "sync:error", { code: "ROOM_REQUIRED", message: "Join a room first." });
    return;
  }

  const participant = room.participants.get(sessionId);
  const text = String(payload?.text ?? "").trim().slice(0, 500);
  if (!participant || !text) {
    return;
  }

  const message = {
    id: randomUUID(),
    roomId,
    sender: participant.nickname,
    text,
    sentAt: nowIso(),
  };

  room.chatMessages.push(message);
  room.chatMessages = room.chatMessages.slice(-CHAT_LIMIT);
  room.updatedAt = Date.now();
  broadcastRoom(room, "chat:new", message);
}

function handleHeartbeat(ws, sessionId) {
  const client = clients.get(sessionId);
  if (!client?.roomId) {
    return;
  }

  const room = rooms.get(client.roomId);
  const participant = room?.participants.get(sessionId);
  if (!participant) {
    return;
  }

  participant.lastHeartbeat = Date.now();
  participant.presence = "online";
  room.updatedAt = Date.now();
  updatePresence(room);
}

function pruneRooms() {
  const currentTime = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    for (const participant of room.participants.values()) {
      if (currentTime - participant.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        participant.presence = "offline";
      }
    }

    ensureHost(room);

    const hasOnline = Array.from(room.participants.values()).some(
      (participant) => participant.presence === "online",
    );

    if (!hasOnline && currentTime - room.updatedAt > ROOM_TTL_MS) {
      rooms.delete(roomId);
      continue;
    }

    updatePresence(room);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      name: "watch-together-backend",
      status: "ok",
      rooms: rooms.size,
      timestamp: nowIso(),
    }),
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const sessionId = randomUUID();
  clients.set(sessionId, { ws, roomId: null });
  send(ws, "session:welcome", { sessionId, serverTime: Date.now() });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      send(ws, "sync:error", { code: "BAD_JSON", message: "Invalid JSON payload." });
      return;
    }

    const { type, payload } = message ?? {};

    switch (type) {
      case "room:create":
        handleRoomCreate(ws, sessionId, payload);
        break;
      case "room:join":
        handleRoomJoin(ws, sessionId, payload);
        break;
      case "media:event":
        handleMediaEvent(ws, sessionId, payload);
        break;
      case "chat:send":
        handleChatSend(ws, sessionId, payload);
        break;
      case "presence:heartbeat":
        handleHeartbeat(ws, sessionId, payload);
        break;
      default:
        send(ws, "sync:error", { code: "UNKNOWN_EVENT", message: `Unknown event: ${type}` });
        break;
    }
  });

  ws.on("close", () => {
    leaveRoom(sessionId);
    clients.delete(sessionId);
  });
});

setInterval(pruneRooms, 5000);

server.listen(PORT, () => {
  console.log(`Watch Together backend listening on http://localhost:${PORT}`);
});
