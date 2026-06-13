const els = {
  backendUrl: document.getElementById("backendUrl"),
  nickname: document.getElementById("nickname"),
  roomId: document.getElementById("roomId"),
  createRoom: document.getElementById("createRoom"),
  saveSettings: document.getElementById("saveSettings"),
  joinRoom: document.getElementById("joinRoom"),
  connectionStatus: document.getElementById("connectionStatus"),
  roomStatus: document.getElementById("roomStatus"),
  memberStatus: document.getElementById("memberStatus"),
};

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

function renderState(state) {
  els.backendUrl.value = state.backendUrl || "wss://together-4jvr.onrender.com";
  els.nickname.value = state.nickname || "";
  els.connectionStatus.textContent = `Connection: ${state.connectionStatus}`;
  els.roomStatus.textContent = state.room?.roomId
    ? `Room: ${state.room.roomId} (${state.isHost ? "Host" : "Viewer"})`
    : "Room: not joined";
  els.memberStatus.textContent = `Participants: ${state.participants?.length || 0}`;
}

async function refresh() {
  const state = await send("watchTogether:getState", {});
  renderState(state);
}

els.saveSettings.addEventListener("click", async () => {
  await send("watchTogether:updateSettings", {
    backendUrl: els.backendUrl.value.trim(),
    nickname: els.nickname.value.trim(),
  });
  refresh();
});

els.createRoom.addEventListener("click", async () => {
  await send("watchTogether:createRoom", {
    nickname: els.nickname.value.trim(),
  });
  refresh();
});

els.joinRoom.addEventListener("click", async () => {
  await send("watchTogether:joinRoom", {
    roomId: els.roomId.value.trim().toUpperCase(),
    nickname: els.nickname.value.trim(),
  });
  refresh();
});

refresh();
