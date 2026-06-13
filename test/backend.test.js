import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

function createBufferedSocket(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const listeners = new Set();

  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    queue.push(message);
    for (const listener of listeners) {
      listener();
    }
  });

  return { ws, queue, listeners };
}

function waitForMessage(client, expectedType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), 5000);

    function checkQueue() {
      const index = client.queue.findIndex((message) => message.type === expectedType);
      if (index !== -1) {
        const [message] = client.queue.splice(index, 1);
        clearTimeout(timeout);
        client.listeners.delete(checkQueue);
        resolve(message.payload);
      }
    }

    client.listeners.add(checkQueue);
    checkQueue();
  });
}

test("room create, join, sync, and chat flow", async () => {
  const port = 3100 + Math.floor(Math.random() * 1000);
  const baseUrl = `ws://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["backend/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not start")), 5000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.stderr.on("data", (chunk) => reject(new Error(String(chunk))));
  });

  const client1 = createBufferedSocket(baseUrl);
  const client2 = createBufferedSocket(baseUrl);

  await Promise.all([
    new Promise((resolve) => client1.ws.on("open", resolve)),
    new Promise((resolve) => client2.ws.on("open", resolve)),
  ]);

  await Promise.all([
    waitForMessage(client1, "session:welcome"),
    waitForMessage(client2, "session:welcome"),
  ]);

  const roomStatePromise = waitForMessage(client1, "room:state");
  client1.ws.send(JSON.stringify({ type: "room:create", payload: { nickname: "Host" } }));
  const roomState = await roomStatePromise;
  assert.equal(roomState.participants.length, 1);
  assert.ok(roomState.roomId);

  const joinedStatePromise = waitForMessage(client2, "room:state");
  client2.ws.send(
    JSON.stringify({
      type: "room:join",
      payload: { roomId: roomState.roomId, nickname: "Friend" },
    }),
  );
  const joinedState = await joinedStatePromise;
  assert.equal(joinedState.participants.length, 2);

  const mediaApplyPromise = waitForMessage(client2, "media:apply");
  client1.ws.send(
    JSON.stringify({
      type: "media:event",
      payload: {
        seq: 1,
        type: "play",
        currentTime: 42,
        paused: false,
        playbackRate: 1,
        fingerprint: "https://example.com/video",
      },
    }),
  );
  const mediaApply = await mediaApplyPromise;
  assert.equal(mediaApply.currentTime, 42);
  assert.equal(mediaApply.paused, false);

  const chatNewPromise = waitForMessage(client1, "chat:new");
  client2.ws.send(
    JSON.stringify({
      type: "chat:send",
      payload: {
        roomId: roomState.roomId,
        text: "Selam",
      },
    }),
  );
  const chatNew = await chatNewPromise;
  assert.equal(chatNew.text, "Selam");

  client1.ws.close();
  client2.ws.close();
  server.kill("SIGTERM");
});
