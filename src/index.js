import './index.css';
import sos from '@signageos/front-applet';

// ════════════════════════════════════════════════════════════════════
//  Required: configuration
//
//  Per-device configuration fields are declared in package.json under
//  "sos.config" and become available at runtime on sos.config.* — see
//  https://developers.signageos.io/docs/sos-guides/configuration
//  Defaults below kick in when a field is not set on the device.
// ════════════════════════════════════════════════════════════════════

const DEFAULT_GROUP = 'sync-video-demo';
const DEFAULT_ENGINE = 'sync-server';

const VIDEOS = [
	{
		uid: 'video-1.mp4',
		uri: 'https://static.signageos.io/assets/test-videos-03_AME/video-test-03_15s_1920x1080_2fe7b039750a134aeac1c0a515710007.mp4',
	},
	{
		uid: 'video-2.mp4',
		uri: 'https://static.signageos.io/assets/test-videos-06_AME/video-test-06_15s_1920x1080_6bad9be8f365760ae505dab34582978b.mp4',
	},
	{
		uid: 'video-3.mp4',
		uri: 'https://static.signageos.io/assets/test-videos-04_AME/video-test-04_15s_1920x1080_88f90af5fa281d7efb8eae17848e71d9.mp4',
	},
];

// ════════════════════════════════════════════════════════════════════
//  Required: synchronized playback
//
//  This is the code customers should copy. Everything below the
//  "OPTIONAL" divider is just the on-screen debug overlay — it isn't
//  needed for sync to work.
// ════════════════════════════════════════════════════════════════════

sos.onReady().then(async () => {
	// Read a readable device identity. Used as deviceIdentification on
	// joinGroup() so peers recognize each other by name, and as the
	// 'from' field on every outgoing broadcast.
	const deviceName = await sos.deviceInfo.getDeviceName();
	const deviceId = deviceName || `device-${Math.random().toString(36).slice(2, 8)}`;

	installDebugOverlay(deviceId); // OPTIONAL — see bottom of file.

	// Step 1: cache each video offline so playback starts instantly
	// on every device. loadOrSaveFile is idempotent — it downloads on
	// first run, returns the local path on subsequent runs.
	for (const v of VIDEOS) {
		const file = await sos.offline.cache.loadOrSaveFile(v.uid, v.uri);
		v.filePath = file.filePath;
	}

	// Precompute the full-screen rectangle every sos.video.* call needs.
	const w = document.documentElement.clientWidth;
	const h = document.documentElement.clientHeight;
	for (const v of VIDEOS) v.rect = [v.filePath, 0, 0, w, h];

	// Step 2: connect to the sync engine.
	//   'sync-server' — uses the signageOS sync server (works across networks).
	//   'p2p-local'   — peer-to-peer on the same LAN, no server needed.
	const engine = (sos.config && sos.config.sync_engine) || DEFAULT_ENGINE;
	const customUri = sos.config && sos.config.sync_server_uri;
	const connectOpts = engine === 'sync-server' && customUri
		? { engine, uri: customUri }
		: { engine };
	await sos.sync.connect(connectOpts);

	// Step 3: join the sync group. Every device that uses the same
	// groupName will rendezvous on each sos.sync.wait() call below.
	// Passing deviceIdentification makes this peer's id readable
	// instead of an auto-generated hash.
	const groupName = (sos.config && sos.config.sync_group) || DEFAULT_GROUP;
	await sos.sync.joinGroup({ groupName, deviceIdentification: deviceId });

	// Step 3.5: subscribe to broadcasts from other peers, and emit a
	// heartbeat ourselves every 5 seconds. broadcastValue/onValue is
	// the pub/sub side of the sync API — independent of wait().
	sos.sync.onValue((key, value, fromGroup) => {
		// `value` is whatever the sender broadcast — by convention we
		// include a `from` field so listeners know who sent it.
		console.log('[broadcast received]', { group: fromGroup, key, value });
	});
	let beat = 0;
	setInterval(() => {
		sos.sync.broadcastValue({
			groupName,
			key: 'heartbeat',
			value: { from: deviceId, beat: ++beat, ts: Date.now() },
		}).catch((e) => console.warn('[broadcast failed]', e && e.message));
	}, 5000);

	// Pre-prepare the first video in the background layer. The player
	// has two video planes: a foreground plane (z=100, covers HTML) and
	// a background plane (z=9, sits behind the applet). Passing
	// { background: true } to prepare() routes playback to the
	// background plane so HTML overlays (status badge, call log) stay
	// visible on top — the standard "Video + HTML5 overlay" pattern.
	// Without this, the very first play() would default to foreground.
	const VIDEO_OPTS = { background: true };
	await sos.video.prepare(VIDEOS[0].rect[0], VIDEOS[0].rect[1], VIDEOS[0].rect[2], VIDEOS[0].rect[3], VIDEOS[0].rect[4], VIDEO_OPTS);

	// Step 4: synchronized playback loop.
	let currentIndex = 0;
	let previousIndex = -1;
	let preparedIndex = 0;

	while (true) {
		const current = VIDEOS[currentIndex];

		// 4a) Rendezvous: every device calls wait(uid) and they all
		//     resolve together with the *master's* uid. Trust the
		//     resolved value — not the local index — so devices that
		//     joined late or fell behind re-converge.
		const resolvedUid = await sos.sync.wait(current.uid, groupName);
		const resolvedIndex = VIDEOS.findIndex((v) => v.uid === resolvedUid);

		// Clean up a previously prepared video that no longer matches.
		if (preparedIndex >= 0 && preparedIndex !== resolvedIndex && preparedIndex !== previousIndex) {
			await sos.video.stop(...VIDEOS[preparedIndex].rect);
			preparedIndex = -1;
		}

		let endedPromise;
		if (resolvedIndex === currentIndex) {
			// 4b) Play the synced video. Every device reaches this line together.
			await sos.video.play(...current.rect);
			if (previousIndex >= 0 && previousIndex !== currentIndex) {
				await sos.video.stop(...VIDEOS[previousIndex].rect);
			}
			previousIndex = currentIndex;
			endedPromise = sos.video.onceEnded(...current.rect);
		}

		// 4c) Pre-buffer the next video in the background while the
		//     current one plays. Eliminates the gap between videos.
		const nextIndex = (resolvedIndex + 1) % VIDEOS.length;
		const next = VIDEOS[nextIndex];
		await sos.video.prepare(next.rect[0], next.rect[1], next.rect[2], next.rect[3], next.rect[4], VIDEO_OPTS);
		preparedIndex = nextIndex;

		// 4d) Wait for the current video to finish, then advance.
		if (endedPromise) await endedPromise;
		currentIndex = nextIndex;
	}
}).catch((err) => {
	console.error('[sync-video-demo] fatal', err);
});

// ════════════════════════════════════════════════════════════════════
//  OPTIONAL: on-screen debug overlay
//
//  Everything below this line just visualizes what the code above is
//  doing. It mounts two overlays on the page (a status badge + a call
//  log) and monkey-patches the sos.* methods used above so each call
//  shows up in the panel as it happens. None of this is required for
//  synchronized playback — delete this section and the demo still
//  works end-to-end.
//
//  Enable/disable via sos.config.debugEnabled (declared in package.json).
//  Defaults to 'true' — set to 'false' on production devices.
//  Click anywhere on the page to hide/show the panel.
// ════════════════════════════════════════════════════════════════════

function installDebugOverlay(deviceId) {
	const cfg = sos.config || {};
	if (cfg.debugEnabled === 'false') return; // Overlay disabled.

	const stage = document.getElementById('stage') || document.body;
	const groupName = cfg.sync_group || DEFAULT_GROUP;
	const me = deviceId || '(me)';

	// --- Status overlay (top-left) ---
	// Two rows for master state, because the two sources can disagree:
	//
	//   • onStatus.isMaster — value from the player's status broadcast.
	//     OLDER "core apps" (player firmware) don't include isMaster in
	//     status messages, in which case @signageos/front-applet falls
	//     back to false (see Sync.js handleMessageData,
	//     `statusMessage.isMaster ?? false`). On those devices this
	//     row will read SLAVE on every peer — including the master.
	//
	//   • sos.sync.isMaster() — direct RPC to the player on demand.
	//     Goes through a different code path that's available on
	//     every supported player and always returns the live answer.
	//
	// Showing both side-by-side makes the discrepancy visible so
	// customers know which source to trust on legacy hardware.
	const statusEl = document.createElement('div');
	statusEl.id = 'status';
	statusEl.innerHTML =
		`<div class="status-line"><span class="lbl">me</span><span class="val me" id="status-me">${escapeHtml(me)}</span></div>` +
		'<div class="status-line"><span class="lbl">group / peers</span><span class="val" id="status-group">connecting…</span></div>' +
		'<div class="status-line"><span class="lbl">onStatus.isMaster</span><span class="val" id="status-onstatus">?</span></div>' +
		'<div class="status-line"><span class="lbl">sos.sync.isMaster()</span><span class="val" id="status-poll">?</span></div>';
	stage.appendChild(statusEl);
	const setText = (id, text, cls) => {
		const el = document.getElementById(id);
		if (!el) return;
		el.textContent = text;
		el.className = 'val' + (cls ? ' ' + cls : '');
	};

	// Poll sos.sync.isMaster() every 5s — that's the source of truth.
	let lastPolled = null;
	const pollMaster = async () => {
		try {
			const r = await sos.sync.isMaster(groupName);
			lastPolled = r;
			setText('status-poll', r ? 'MASTER' : 'SLAVE', r ? 'master' : 'slave');
		} catch (e) {
			setText('status-poll', `error: ${e && e.message}`, 'err');
		}
	};
	setInterval(pollMaster, 5000);
	// Kick off one immediate poll once joinGroup has had a moment.
	setTimeout(pollMaster, 1500);

	// --- Peer activity panel (top-right) ---
	// Surfaces who is sending what across the group, separate from the
	// raw API call log. Three event kinds:
	//   ↑ TX  — broadcasts THIS device sent (via sos.sync.broadcastValue)
	//   ↓ RX  — broadcasts received from others (via sos.sync.onValue)
	//   ⟳ rdz — sync.wait() rendezvous events, with proposed vs. resolved
	const paPanel = document.createElement('div');
	paPanel.id = 'peer-activity';
	paPanel.innerHTML =
		'<div class="pa-header">peer activity (TX / RX / rendezvous)</div>' +
		'<ol class="pa-list"></ol>';
	stage.appendChild(paPanel);
	const paList = paPanel.querySelector('.pa-list');
	let paSeq = 0;
	const paAppend = (cls, html) => {
		const li = document.createElement('li');
		li.className = cls;
		li.innerHTML = html;
		paList.appendChild(li);
		if (paList.children.length > 60) paList.removeChild(paList.firstChild);
		paList.scrollTop = paList.scrollHeight;
	};
	// Stable color hash for a peer id, so each device shows in the same hue.
	const peerColor = (id) => {
		let h = 0;
		for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
		const hue = Math.abs(h) % 360;
		return `hsl(${hue}, 65%, 70%)`;
	};
	const peerSpan = (id) => `<span class="peer" style="color:${peerColor(id)}">${escapeHtml(id)}</span>`;

	const paTx = (key, value) => {
		paSeq++;
		const valStr = escapeHtml(fmt(value));
		paAppend('pa-tx',
			`<span class="ts">${ts()}</span> <span class="n">#${paSeq}</span> ` +
			`<span class="dir">↑ TX</span> from ${peerSpan(me)} → all peers: ` +
			`<span class="key">${escapeHtml(key)}</span> = <span class="val">${valStr}</span>`);
	};
	const paRx = (key, value, fromId) => {
		paSeq++;
		const valStr = escapeHtml(fmt(value));
		paAppend('pa-rx',
			`<span class="ts">${ts()}</span> <span class="n">#${paSeq}</span> ` +
			`<span class="dir">↓ RX</span> from ${peerSpan(fromId || '?')}: ` +
			`<span class="key">${escapeHtml(key)}</span> = <span class="val">${valStr}</span>`);
	};
	const paRdz = (proposed, resolved) => {
		paSeq++;
		const agree = proposed === resolved;
		paAppend('pa-rdz',
			`<span class="ts">${ts()}</span> <span class="n">#${paSeq}</span> ` +
			`<span class="dir">⟳ rdz</span> ${peerSpan(me)} proposed <span class="val">${escapeHtml(fmt(proposed))}</span> · ` +
			`group resolved <span class="val ${agree ? 'agree' : 'override'}">${escapeHtml(fmt(resolved))}</span>` +
			(agree ? '' : ' <span class="note">(master overrode)</span>'));
	};

	// --- Call log panel (bottom-right) ---
	const panel = document.createElement('div');
	panel.id = 'call-log';
	panel.innerHTML =
		'<div class="call-log-header">sos API call log — click to toggle</div>' +
		'<ol class="call-log-list"></ol>';
	stage.appendChild(panel);
	const list = panel.querySelector('.call-log-list');

	stage.addEventListener('click', () => panel.classList.toggle('hidden'));

	// --- Log helpers ---
	let seq = 0;
	const startedAt = Date.now();
	const ts = () => `+${((Date.now() - startedAt) / 1000).toFixed(2).padStart(7, ' ')}s`;
	const fmt = (v) => {
		if (v === undefined) return 'undefined';
		if (v === null) return 'null';
		if (typeof v === 'string') return `'${v.length > 40 ? v.slice(0, 37) + '…' : v}'`;
		if (typeof v === 'number' || typeof v === 'boolean') return String(v);
		try { return JSON.stringify(v); } catch (_) { return String(v); }
	};
	function escapeHtml(s) {
		return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}
	const append = (html) => {
		const li = document.createElement('li');
		li.innerHTML = html;
		list.appendChild(li);
		if (list.children.length > 200) list.removeChild(list.firstChild);
		list.scrollTop = list.scrollHeight;
		return li;
	};
	const event = (label, detail) => {
		const id = ++seq;
		const d = detail === undefined ? '' : ` ${fmt(detail)}`;
		append(`<span class="ts">${ts()}</span> <span class="n">#${id}</span> <span class="evt">▸ ${label}</span><span class="ret">${d}</span>`);
	};

	// --- Patch helper: replace owner[method] with a logging wrapper ---
	const patch = (owner, method, label) => {
		const original = owner[method].bind(owner);
		owner[method] = async function () {
			const id = ++seq;
			const args = Array.prototype.slice.call(arguments);
			const li = append(
				`<span class="ts">${ts()}</span> <span class="n">#${id}</span> ` +
				`<span class="call">${label}(${args.map(fmt).join(', ')})</span> <span class="state">…</span>`
			);
			const stateEl = li.querySelector('.state');
			const start = Date.now();
			try {
				const result = await original.apply(this, args);
				stateEl.className = 'state ok';
				// Most signageOS SDK methods return Promise<void>. Showing
				// "→ undefined" is correct but noisy — use a checkmark
				// instead and only render the value when it's meaningful.
				const tail = result === undefined
					? '✓'
					: `→ <span class="ret">${fmt(result)}</span>`;
				stateEl.innerHTML = `${tail} <span class="dur">(${Date.now() - start}ms)</span>`;
				return result;
			} catch (err) {
				stateEl.className = 'state err';
				stateEl.innerHTML = `✗ ${err && err.message} <span class="dur">(${Date.now() - start}ms)</span>`;
				throw err;
			}
		};
	};

	// Patch every sos.* method the demo uses, so they appear in the log.
	patch(sos.offline.cache, 'loadOrSaveFile', 'sos.offline.cache.loadOrSaveFile');
	patch(sos.sync,          'connect',        'sos.sync.connect');
	patch(sos.sync,          'joinGroup',      'sos.sync.joinGroup');
	patch(sos.sync,          'leaveGroup',     'sos.sync.leaveGroup');
	patch(sos.sync,          'close',          'sos.sync.close');
	patch(sos.sync,          'broadcastValue', 'sos.sync.broadcastValue');
	patch(sos.sync,          'wait',           'sos.sync.wait');
	patch(sos.video,         'prepare',        'sos.video.prepare');
	patch(sos.video,         'play',           'sos.video.play');
	patch(sos.video,         'stop',           'sos.video.stop');
	patch(sos.video,         'onceEnded',      'sos.video.onceEnded');

	// Mirror broadcastValue calls into the peer-activity panel as TX events.
	const _bv = sos.sync.broadcastValue.bind(sos.sync);
	sos.sync.broadcastValue = function (opts) {
		if (opts && typeof opts.key === 'string') paTx(opts.key, opts.value);
		return _bv(opts);
	};

	// Mirror wait() rendezvous results into the peer-activity panel.
	const _wait = sos.sync.wait.bind(sos.sync);
	sos.sync.wait = async function (data, group, timeout) {
		const resolved = await _wait(data, group, timeout);
		paRdz(data, resolved);
		return resolved;
	};

	// Stream sync events into the call log + peer-activity panel.
	sos.sync.onStatus((s) => {
		event('sos.sync.onStatus', { peers: s.connectedPeers.length, isMaster: s.isMaster, group: s.groupName });
		const peerList = (s.connectedPeers || []).map((p) => p === me ? `<b>${peerSpan(p)}</b>` : peerSpan(p)).join(', ');
		setText('status-group', `${s.groupName || '(default)'} · peers: ${s.connectedPeers.length}`);
		// Replace status-group HTML with colored peer chips when we have peers.
		if (s.connectedPeers && s.connectedPeers.length) {
			const el = document.getElementById('status-group');
			if (el) el.innerHTML = `${escapeHtml(s.groupName || '(default)')} · ${peerList}`;
		}
		setText('status-onstatus', s.isMaster ? 'MASTER' : 'SLAVE', s.isMaster ? 'master' : 'slave');
	});
	sos.sync.onValue((key, value, groupName) => {
		event('sos.sync.onValue', { groupName, key, value });
		// Sender id by convention lives in value.from. Listeners that
		// want to know who sent a broadcast should include it themselves.
		const fromId = value && typeof value === 'object' ? value.from : undefined;
		// Skip our own broadcasts if the engine echoes them back to us.
		if (fromId !== me) paRx(key, value, fromId);
	});
	sos.sync.onClosed((err) => {
		event('sos.sync.onClosed', err ? { error: err.message } : '(graceful)');
	});
}
