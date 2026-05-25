# sync-video-demo

A signageOS applet demonstrating **synchronized video playback** across multiple
devices using the `sos.sync` API, with an on-screen call log that shows every
SDK function as it is invoked.

It's the modern replacement for the legacy
[`applet-examples/.../sync-video/cli-applet`](https://github.com/signageos/applet-examples/tree/master/examples/content-js-api/sync-video/cli-applet)
example, updated for `@signageos/front-applet` v8.

## What the applet does

1. Caches three demo videos offline via `sos.offline.cache.loadOrSaveFile()`.
2. Connects to the sync engine via `sos.sync.connect({ engine })`.
3. Joins a sync group named `sync-video-demo` via `sos.sync.joinGroup()`.
4. Enters a synchronized playback loop:
   - `sos.sync.wait(uid)` — every device rendezvous before playing.
   - `sos.video.play(...)` — all devices start the same video together.
   - `sos.video.prepare(...)` — pre-buffer the next video in the background.
   - `sos.video.onceEnded(...)` — wait for the current video to finish, advance.

## What you see on the screen

- The synchronized video playing full-screen.
- A **call log panel** (bottom-right) listing every signageOS SDK call in the
  order it was invoked, with arguments, return values, and call duration.
- A **status badge** (top-left) showing the current sync group, peer count, and
  master status, updated live from `sos.sync.onStatus`.

**Toggle the call log:** click anywhere on the screen, or press the `L` key.

## Run it

```bash
npm install
npm start            # serves on http://localhost:8090 for local preview
npm run build        # production build into ./dist
npm run upload       # upload the applet to signageOS via the sos CLI
```

## Try it on multiple devices

1. Upload the applet with `npm run upload`.
2. Assign the applet to **two or more devices** in the signageOS box.
3. Optionally tune the [applet configuration](https://developers.signageos.io/docs/sos-guides/configuration) per device or per assignment — fields declared in `package.json` under `sos.config` and read at runtime via `sos.config.*`:

   | Field             | Type   | Default            | Purpose |
   |-------------------|--------|--------------------|---------|
   | `sync_engine`     | enum   | `sync-server`      | `sync-server` (cross-network, via signageOS sync server) or `p2p-local` (LAN-only, serverless). |
   | `sync_group`      | string | `sync-video-demo`  | All devices sharing the same value play in lockstep. Use different values to run independent groups on the same account. |
   | `sync_server_uri` | url    | _(default server)_ | Only honored when `sync_engine = sync-server`. Point to a self-hosted sync server (e.g. `wss://sync.example.com`). |
   | `debugEnabled`    | enum   | `true`             | On-screen status badge + sos API call log. Set to `false` for production. Click the screen to hide/show the panel. |

4. Watch the devices: they should start the same video at the same moment, and
   every transition should happen in lockstep. The call log shows the exact
   sequence of `sos.sync.wait` → `sos.video.play` → `sos.video.prepare` →
   `sos.video.onceEnded` on each device.

## Files of interest

- [`src/index.js`](./src/index.js) — the demo, with inline `// Step N:` comments
  matching the README. The `callLog.wrap(label, fn)` helper is how each API
  call is intercepted for the on-screen log; the SDK calls themselves are
  exactly what you'd write in production code.
- [`src/index.css`](./src/index.css) — overlay styling.
- [`public/index.html`](./public/index.html) — minimal stage container.

## Sync API reference

- [`sos.sync` docs](https://developers.signageos.io/sdk/sos/sync)
- [`sos.video` docs](https://developers.signageos.io/sdk/sos/video)
- [`sos.offline.cache` docs](https://developers.signageos.io/sdk/sos/offline/cache)
