const DEFAULT_SETTINGS = {
  backendUrl: "wss://together-4jvr.onrender.com",
  nickname: "",
};

const state = {
  socket: null,
  socketUrl: DEFAULT_SETTINGS.backendUrl,
  reconnectTimer: null,
  reconnectAttempt: 0,
  sessionId: null,
  connectionStatus: "disconnected",
  room: null,
  participants: [],
  hostSessionId: null,
  mediaState: null,
  chatMessages: [],
  activeTabId: null,
  nickname: "",
  pendingAction: null,
};

function loadSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS).then((settings) => {
    state.socketUrl = settings.backendUrl;
    state.nickname = settings.nickname || "";
  });
}

function persistNickname(nickname) {
  state.nickname = nickname;
  return chrome.storage.sync.set({ nickname });
}

function serializeState() {
  return {
    connectionStatus: state.connectionStatus,
    sessionId: state.sessionId,
    room: state.room,
    participants: state.participants,
    hostSessionId: state.hostSessionId,
    mediaState: state.mediaState,
    chatMessages: state.chatMessages,
    nickname: state.nickname,
    backendUrl: state.socketUrl,
    isHost: Boolean(state.hostSessionId && state.hostSessionId === state.sessionId),
  };
}

function sendToTab(tabId, message) {
  if (!tabId) {
    return;
  }

  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

function broadcastToTrackedTabs(message) {
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        sendToTab(tab.id, message);
      }
    }
  });
}

function notifyClients() {
  broadcastToTrackedTabs({ type: "watchTogether:state", payload: serializeState() });
}

function connectSocket() {
  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) {
    return Promise.resolve();
  }

  state.connectionStatus = "connecting";
  notifyClients();

  return new Promise((resolve) => {
    state.socket = new WebSocket(state.socketUrl);

    state.socket.addEventListener("open", () => {
      state.connectionStatus = "connected";
      state.reconnectAttempt = 0;
      notifyClients();
      if (state.room?.roomId) {
        sendSocket("room:join", {
          roomId: state.room.roomId,
          nickname: state.nickname,
        });
      }
      if (typeof state.pendingAction === "function") {
        const action = state.pendingAction;
        state.pendingAction = null;
        action();
      }
      resolve();
    });

    state.socket.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      handleSocketEvent(data.type, data.payload);
    });

    state.socket.addEventListener("close", () => {
      state.connectionStatus = "disconnected";
      notifyClients();
      scheduleReconnect();
    });

    state.socket.addEventListener("error", () => {
      state.connectionStatus = "error";
      notifyClients();
      resolve();
    });
  });
}

function runWhenConnected(action) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    action();
    return Promise.resolve(true);
  }

  state.pendingAction = action;
  return connectSocket().then(() => state.socket?.readyState === WebSocket.OPEN);
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delay = Math.min(1000 * 2 ** state.reconnectAttempt, 15000);
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(() => connectSocket(), delay);
}

function sendSocket(type, payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  state.socket.send(JSON.stringify({ type, payload }));
  return true;
}

function handleSocketEvent(type, payload) {
  switch (type) {
    case "session:welcome":
      state.sessionId = payload.sessionId;
      notifyClients();
      break;
    case "room:state":
      state.room = {
        roomId: payload.roomId,
        mediaState: payload.mediaState,
      };
      state.hostSessionId = payload.hostSessionId;
      state.participants = payload.participants || [];
      state.mediaState = payload.mediaState || null;
      state.chatMessages = payload.chatMessages || state.chatMessages;
      notifyClients();
      broadcastToTrackedTabs({ type: "watchTogether:roomState", payload: serializeState() });
      break;
    case "presence:update":
      state.participants = payload.participants || [];
      state.hostSessionId = payload.hostSessionId || null;
      notifyClients();
      broadcastToTrackedTabs({ type: "watchTogether:presence", payload: serializeState() });
      break;
    case "media:apply":
      state.mediaState = payload;
      notifyClients();
      broadcastToTrackedTabs({ type: "watchTogether:mediaApply", payload });
      break;
    case "chat:new":
      state.chatMessages = [...state.chatMessages, payload].slice(-50);
      notifyClients();
      broadcastToTrackedTabs({ type: "watchTogether:chatNew", payload });
      break;
    case "sync:error":
      broadcastToTrackedTabs({ type: "watchTogether:error", payload });
      break;
    default:
      break;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  loadSettings().then(connectSocket);
});

chrome.runtime.onStartup.addListener(() => {
  loadSettings().then(connectSocket);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  state.activeTabId = tabId;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (payload) => sendResponse(payload);

  if (message?.type === "watchTogether:getState") {
    if (!state.socket) {
      loadSettings().then(connectSocket).then(() => respond(serializeState()));
      return true;
    }

    respond(serializeState());
    return false;
  }

  if (message?.type === "watchTogether:updateSettings") {
    const backendUrl = String(message.payload?.backendUrl || DEFAULT_SETTINGS.backendUrl);
    const nickname = String(message.payload?.nickname || "");
    state.socketUrl = backendUrl;
    persistNickname(nickname).then(() => {
      if (state.socket) {
        state.socket.close();
      } else {
        connectSocket();
      }
      respond({ ok: true });
    });
    chrome.storage.sync.set({ backendUrl });
    return true;
  }

  if (message?.type === "watchTogether:createRoom") {
    persistNickname(message.payload?.nickname || state.nickname).then(() => {
      runWhenConnected(() => {
        sendSocket("room:create", { nickname: state.nickname });
      }).then(() => {
        respond({ ok: true });
      });
    });
    return true;
  }

  if (message?.type === "watchTogether:joinRoom") {
    const nickname = message.payload?.nickname || state.nickname;
    persistNickname(nickname).then(() => {
      runWhenConnected(() => {
        sendSocket("room:join", {
          roomId: message.payload?.roomId,
          nickname: state.nickname,
        });
      }).then(() => {
        respond({ ok: true });
      });
    });
    return true;
  }

  if (message?.type === "watchTogether:sendMediaEvent") {
    const payload = {
      ...message.payload,
      roomId: state.room?.roomId,
    };
    runWhenConnected(() => {
      sendSocket("media:event", payload);
    }).then((ok) => {
      respond({ ok: true });
    });
    return true;
  }

  if (message?.type === "watchTogether:sendChat") {
    runWhenConnected(() => {
      sendSocket("chat:send", {
        roomId: state.room?.roomId,
        text: message.payload?.text,
      });
    }).then(() => {
      respond({ ok: true });
    });
    return true;
  }

  if (message?.type === "watchTogether:heartbeat") {
    sendSocket("presence:heartbeat", { roomId: state.room?.roomId });
    return false;
  }

  if (message?.type === "watchTogether:contentReady") {
    if (sender.tab?.id) {
      state.activeTabId = sender.tab.id;
      sendToTab(sender.tab.id, { type: "watchTogether:roomState", payload: serializeState() });
    }
    respond({ ok: true });
    return false;
  }

  return false;
});

loadSettings().then(connectSocket);
