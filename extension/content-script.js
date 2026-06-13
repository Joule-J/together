(function watchTogetherContentScript() {
  const DRIFT_SOFT_LIMIT = 0.4;
  const DRIFT_HARD_LIMIT = 2;
  const HEARTBEAT_INTERVAL_MS = 10000;
  const CHAT_AUTO_HIDE_MS = 4000;

  let currentState = null;
  let activeVideo = null;
  let seq = 0;
  let suppressLocalEvents = false;
  let overlay = null;
  let overlayState = {
    pinned: false,
    visible: true,
    lastError: "",
  };

  function fingerprintFromLocation() {
    const url = new URL(window.location.href);
    return `${url.origin}${url.pathname}`;
  }

  function getBestVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) {
      return null;
    }

    return videos.sort((a, b) => {
      const aScore = a.clientWidth * a.clientHeight + (a.paused ? 0 : 50000);
      const bScore = b.clientWidth * b.clientHeight + (b.paused ? 0 : 50000);
      return bScore - aScore;
    })[0];
  }

  function sendMessage(type, payload) {
    return chrome.runtime.sendMessage({ type, payload }).catch(() => null);
  }

  function updateOverlayVisibility(showTemporarily = false) {
    if (!overlay) {
      return;
    }

    const fullscreen = Boolean(document.fullscreenElement);
    if (!fullscreen) {
      overlay.root.classList.remove("is-hidden");
      return;
    }

    if (overlayState.pinned || showTemporarily) {
      overlay.root.classList.remove("is-hidden");
      if (showTemporarily && !overlayState.pinned) {
        window.clearTimeout(overlayState.hideTimer);
        overlayState.hideTimer = window.setTimeout(() => {
          overlay.root.classList.add("is-hidden");
        }, CHAT_AUTO_HIDE_MS);
      }
      return;
    }

    overlay.root.classList.add("is-hidden");
  }

  function renderOverlay() {
    if (!overlay) {
      overlay = createOverlay();
    }

    const roomId = currentState?.room?.roomId || "Not connected";
    const memberCount = currentState?.participants?.length || 0;
    const status = currentState?.connectionStatus || "disconnected";
    const isHost = currentState?.isHost ? "Host" : "Viewer";
    const hasVideo = Boolean(activeVideo);

    overlay.badge.textContent = hasVideo ? `Video ready` : `Player not found`;
    overlay.room.textContent = `Room ${roomId}`;
    overlay.meta.textContent = `${memberCount} people • ${isHost} • ${status}`;
    overlay.messages.innerHTML = "";

    const messages = currentState?.chatMessages || [];
    for (const message of messages.slice(-8)) {
      const item = document.createElement("div");
      item.className = "wt-message";
      item.textContent = `${message.sender}: ${message.text}`;
      overlay.messages.appendChild(item);
    }

    overlay.root.classList.toggle("has-error", !hasVideo || Boolean(overlayState.lastError));
    overlay.error.textContent = overlayState.lastError || (!hasVideo ? "This page has no active HTML5 video." : "");
    updateOverlayVisibility(false);
  }

  function createOverlay() {
    const root = document.createElement("div");
    root.className = "wt-overlay";
    root.innerHTML = `
      <style>
        .wt-overlay {
          position: fixed;
          right: max(16px, env(safe-area-inset-right));
          bottom: max(16px, env(safe-area-inset-bottom));
          width: 320px;
          z-index: 2147483647;
          font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #f4f7fb;
          transition: opacity 180ms ease, transform 180ms ease;
        }
        .wt-overlay.is-hidden {
          opacity: 0.08;
          transform: translateY(12px);
        }
        .wt-card {
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 16px;
          background: rgba(10, 15, 26, 0.88);
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(18px);
        }
        .wt-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 14px 8px;
        }
        .wt-title {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .wt-badge {
          font-size: 11px;
          color: #9dd7ff;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .wt-room {
          font-size: 14px;
          font-weight: 700;
        }
        .wt-meta {
          font-size: 12px;
          color: rgba(255, 255, 255, 0.72);
        }
        .wt-pin {
          border: 0;
          border-radius: 999px;
          padding: 8px 10px;
          background: rgba(255, 255, 255, 0.08);
          color: #f4f7fb;
          cursor: pointer;
        }
        .wt-body {
          padding: 0 14px 14px;
        }
        .wt-messages {
          max-height: 176px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 8px 0 12px;
        }
        .wt-message {
          padding: 8px 10px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.06);
          font-size: 13px;
          line-height: 1.35;
          word-break: break-word;
        }
        .wt-form {
          display: flex;
          gap: 8px;
        }
        .wt-input {
          flex: 1;
          min-width: 0;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 10px;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.06);
          color: #fff;
          outline: none;
        }
        .wt-submit {
          border: 0;
          border-radius: 10px;
          padding: 10px 14px;
          background: linear-gradient(135deg, #41b3ff, #1d7ff2);
          color: white;
          font-weight: 700;
          cursor: pointer;
        }
        .wt-error {
          min-height: 18px;
          margin-top: 8px;
          color: #ff9c9c;
          font-size: 12px;
        }
      </style>
      <div class="wt-card">
        <div class="wt-header">
          <div class="wt-title">
            <span class="wt-badge"></span>
            <span class="wt-room"></span>
            <span class="wt-meta"></span>
          </div>
          <button class="wt-pin" type="button">Pin</button>
        </div>
        <div class="wt-body">
          <div class="wt-messages"></div>
          <form class="wt-form">
            <input class="wt-input" maxlength="500" placeholder="Send a message" />
            <button class="wt-submit" type="submit">Send</button>
          </form>
          <div class="wt-error"></div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    const pin = root.querySelector(".wt-pin");
    const form = root.querySelector(".wt-form");
    const input = root.querySelector(".wt-input");

    pin.addEventListener("click", () => {
      overlayState.pinned = !overlayState.pinned;
      pin.textContent = overlayState.pinned ? "Unpin" : "Pin";
      updateOverlayVisibility(overlayState.pinned);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) {
        return;
      }
      await sendMessage("watchTogether:sendChat", { text });
      input.value = "";
      updateOverlayVisibility(true);
    });

    return {
      root,
      badge: root.querySelector(".wt-badge"),
      room: root.querySelector(".wt-room"),
      meta: root.querySelector(".wt-meta"),
      messages: root.querySelector(".wt-messages"),
      error: root.querySelector(".wt-error"),
    };
  }

  function emitMediaEvent(type) {
    if (!activeVideo || suppressLocalEvents || !currentState?.isHost || !currentState?.room?.roomId) {
      return;
    }

    seq += 1;
    sendMessage("watchTogether:sendMediaEvent", {
      seq,
      type,
      currentTime: activeVideo.currentTime,
      paused: activeVideo.paused,
      playbackRate: activeVideo.playbackRate,
      fingerprint: fingerprintFromLocation(),
      clientSentAt: Date.now(),
    });
  }

  function bindVideo(video) {
    if (activeVideo === video) {
      return;
    }

    activeVideo = video;
    const events = ["play", "pause", "seeked", "ratechange", "waiting"];
    for (const eventName of events) {
      video.addEventListener(eventName, () => emitMediaEvent(eventName));
    }

    let lastSentAt = 0;
    video.addEventListener("timeupdate", () => {
      if (Date.now() - lastSentAt < 1200) {
        return;
      }
      lastSentAt = Date.now();
      emitMediaEvent("timeupdate");
    });

    renderOverlay();
  }

  function syncPlaybackRate(diff) {
    if (!activeVideo) {
      return;
    }

    if (Math.abs(diff) <= DRIFT_SOFT_LIMIT) {
      activeVideo.playbackRate = diff > 0 ? 1.05 : 0.95;
      window.setTimeout(() => {
        if (activeVideo) {
          activeVideo.playbackRate = currentState?.mediaState?.playbackRate || 1;
        }
      }, 1200);
      return;
    }

    activeVideo.currentTime = currentState.mediaState.currentTime;
  }

  async function applyRemoteMedia(payload) {
    if (!activeVideo) {
      overlayState.lastError = "Video player not found on this page.";
      renderOverlay();
      return;
    }

    if (currentState?.isHost && payload.hostSessionId === currentState.sessionId) {
      return;
    }

    const localFingerprint = fingerprintFromLocation();
    if (payload.fingerprint && payload.fingerprint !== localFingerprint) {
      overlayState.lastError = "This tab is on a different video URL.";
      renderOverlay();
      return;
    }

    overlayState.lastError = "";
    suppressLocalEvents = true;
    const diff = payload.currentTime - activeVideo.currentTime;

    activeVideo.playbackRate = payload.playbackRate || 1;

    if (Math.abs(diff) >= DRIFT_HARD_LIMIT) {
      activeVideo.currentTime = payload.currentTime;
    } else {
      syncPlaybackRate(diff);
    }

    if (payload.paused && !activeVideo.paused) {
      activeVideo.pause();
    }

    if (!payload.paused && activeVideo.paused) {
      try {
        await activeVideo.play();
      } catch {
        overlayState.lastError = "Autoplay was blocked. Click play once on this page.";
      }
    }

    window.setTimeout(() => {
      suppressLocalEvents = false;
      renderOverlay();
    }, 50);
  }

  function pickVideo() {
    const candidate = getBestVideo();
    if (candidate) {
      bindVideo(candidate);
    } else {
      activeVideo = null;
      renderOverlay();
    }
  }

  function handleRuntimeMessage(message) {
    switch (message?.type) {
      case "watchTogether:roomState":
      case "watchTogether:state":
      case "watchTogether:presence":
        currentState = message.payload;
        renderOverlay();
        break;
      case "watchTogether:mediaApply":
        currentState = { ...(currentState || {}), mediaState: message.payload };
        applyRemoteMedia(message.payload);
        break;
      case "watchTogether:chatNew":
        currentState = {
          ...(currentState || {}),
          chatMessages: [...(currentState?.chatMessages || []), message.payload].slice(-50),
        };
        renderOverlay();
        updateOverlayVisibility(true);
        break;
      case "watchTogether:error":
        overlayState.lastError = message.payload?.message || "Sync error";
        renderOverlay();
        updateOverlayVisibility(true);
        break;
      default:
        break;
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    handleRuntimeMessage(message);
  });

  document.addEventListener("fullscreenchange", () => updateOverlayVisibility(false));
  new MutationObserver(() => pickVideo()).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  setInterval(() => {
    sendMessage("watchTogether:heartbeat", {});
  }, HEARTBEAT_INTERVAL_MS);

  pickVideo();
  renderOverlay();
  sendMessage("watchTogether:contentReady", {});
  sendMessage("watchTogether:getState", {}).then((result) => {
    currentState = result;
    renderOverlay();
  });
})();
