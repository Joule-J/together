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

Extension default backend is `wss://together-4jvr.onrender.com`.

## Load Extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension` folder

## Deploy Backend To Render

1. In Render, choose `New +` -> `Web Service`.
2. Connect the `Joule-J/together` GitHub repo.
3. Render can detect `render.yaml` automatically. If it asks manually, use:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`
4. Deploy the service.
5. After deploy finishes, copy the service URL, such as `https://together-backend.onrender.com`.
6. In the extension popup, set `Backend URL` to the matching WebSocket URL:
   - `wss://together-backend.onrender.com`

Render-specific notes:

- The backend already listens on `PORT`, which Render provides automatically.
- WebSocket connections are supported on Render web services.
- This MVP stores rooms and chat in memory, so state resets when the service restarts or redeploys.
- Free instances can sleep when idle, so the first reconnect may take a bit longer.

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
