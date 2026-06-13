# Watch Together Sync

Chrome extension + Node.js WebSocket backend for synchronizing generic HTML5 video playback and a lightweight fullscreen chat overlay.

## Project Layout

- `backend/server.js`: in-memory room server with WebSocket sync, presence, and chat.
- `extension/manifest.json`: Manifest V3 Chrome extension entrypoint.
- `extension/background.js`: service worker that manages WebSocket state and routes messages.
- `extension/content-script.js`: video detection, playback sync, and fullscreen chat overlay.
- `extension/popup.html`: popup UI for backend URL, nickname, room create/join.

## Run Backend

```bash
npm install
npm start
```

Backend defaults to `ws://localhost:3000`.

## Load Extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension` folder

## Manual Test Flow

1. Start the backend.
2. Load the extension in two Chrome profiles.
3. Open the same HTML5 video page in both profiles.
4. In profile A, create a room and share the room code.
5. In profile B, join the same room.
6. Use play, pause, seek, and chat.
7. Enter fullscreen and verify the chat overlay auto-hides in the bottom-right.

## Scope Notes

- First version targets standard `HTMLVideoElement` websites.
- DRM or custom streaming players are out of scope for this MVP.
- Room and chat state are in-memory only.
