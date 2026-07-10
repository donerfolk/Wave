/**
 * Worker thread for SMTC reads — native calls must not block the main process.
 */
'use strict';

const { parentPort } = require('worker_threads');
const { execFileSync } = require('child_process');
const { SMTCMonitor } = require('@coooookies/windows-smtc-monitor');
const { fromRoot } = require('./app-root');

const PLAYBACK_SCRIPT = fromRoot('scripts', 'apple-music-playback.ps1');
// ponytail: UI Automation query is ~5s; cache and refresh on toggle invalidation or every 3s
const TOGGLE_QUERY_MS = 3000;

/** @type {{ shuffleActive: boolean, repeatMode: string } | null} */
let cachedToggles = null;
let cachedTogglesAt = 0;
let togglesStale = true;
let togglesQueryBlockedUntil = 0;

const PlaybackStatus = {
  Closed: 0,
  Opened: 1,
  Changing: 2,
  Stopped: 3,
  Playing: 4,
  Paused: 5,
};

const APPLE_PATTERNS = [/appleinc/i, /applemusic/i, /music\.exe/i];

/** @type {import('@coooookies/windows-smtc-monitor').SMTCMonitor} */
const monitor = new SMTCMonitor();

function isAppleMusicSession(appId) {
  if (!appId) return false;
  return APPLE_PATTERNS.some((re) => re.test(appId));
}

function queryApplePlaybackState() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', PLAYBACK_SCRIPT, 'query'],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    );
    const data = JSON.parse(out.trim());
    const repeat = ['off', 'all', 'one'].includes(data.repeat) ? data.repeat : 'off';
    return { shuffleActive: Boolean(data.shuffle), repeatMode: repeat };
  } catch {
    return null;
  }
}

function applyApplePlaybackToggles(state) {
  if (!state.active || !isAppleMusicSession(state.sourceAppId)) {
    cachedToggles = null;
    togglesStale = true;
    return state;
  }

  const now = Date.now();
  const cacheFresh = cachedToggles && !togglesStale && now - cachedTogglesAt < TOGGLE_QUERY_MS;
  const queryBlocked = now < togglesQueryBlockedUntil;
  if (!cacheFresh && !queryBlocked) {
    const toggles = queryApplePlaybackState();
    if (toggles) {
      cachedToggles = toggles;
      cachedTogglesAt = now;
      togglesStale = false;
    }
  }

  if (cachedToggles) {
    state.shuffleActive = cachedToggles.shuffleActive;
    state.repeatMode = cachedToggles.repeatMode;
  }
  return state;
}

function thumbnailToDataUrl(thumbnail) {
  if (!thumbnail || !thumbnail.length) return null;
  let mime = 'image/png';
  if (thumbnail[0] === 0xff && thumbnail[1] === 0xd8) mime = 'image/jpeg';
  else if (thumbnail.slice(0, 4).toString('ascii') === 'RIFF') mime = 'image/webp';
  return `data:${mime};base64,${thumbnail.toString('base64')}`;
}

function normalizeSession(session) {
  if (!session) {
    return {
      active: false,
      title: 'Not playing',
      artist: '',
      album: '',
      albumArt: null,
      isPlaying: false,
      trackNumber: 0,
      duration: 0,
      shuffleActive: false,
      repeatMode: 'off',
      sourceAppId: null,
    };
  }

  const status = session.playback?.playbackStatus ?? PlaybackStatus.Closed;
  return {
    active: true,
    title: session.media?.title || 'Unknown track',
    artist: session.media?.artist || session.media?.albumArtist || '',
    album: session.media?.albumTitle || '',
    albumArt: thumbnailToDataUrl(session.media?.thumbnail),
    isPlaying: status === PlaybackStatus.Playing,
    trackNumber: session.media?.trackNumber ?? 0,
    duration: session.timeline?.duration ?? 0,
    shuffleActive: false,
    repeatMode: 'off',
    sourceAppId: session.sourceAppId ?? null,
  };
}

function pickSession() {
  const monitorApple = monitor.sessions.find((s) => isAppleMusicSession(s.sourceAppId));
  const fresh = SMTCMonitor.getMediaSessions?.() ?? [];
  const freshApple = fresh.find((s) => isAppleMusicSession(s.sourceAppId));

  const thumbLen = (s) => s?.media?.thumbnail?.length ?? 0;
  if (thumbLen(freshApple) >= thumbLen(monitorApple)) return freshApple ?? monitorApple;
  return monitorApple ?? freshApple ?? SMTCMonitor.getCurrentMediaSession?.() ?? null;
}

function fetchSession() {
  try {
    const state = applyApplePlaybackToggles(normalizeSession(pickSession()));
    return state;
  } catch {
    return normalizeSession(null);
  }
}

let emitTimer = null;

function emitState() {
  parentPort.postMessage({ type: 'state', state: fetchSession() });
}

function scheduleEmit() {
  clearTimeout(emitTimer);
  emitTimer = setTimeout(emitState, 40);
}

for (const event of [
  'session-media-changed',
  'current-session-changed',
  'session-added',
  'session-removed',
  'session-playback-changed',
]) {
  monitor.on(event, scheduleEmit);
}

function flipCachedToggle(action) {
  if (!cachedToggles) cachedToggles = { shuffleActive: false, repeatMode: 'off' };
  if (action === 'shuffle') {
    cachedToggles = { ...cachedToggles, shuffleActive: !cachedToggles.shuffleActive };
  } else if (action === 'repeat') {
    const cycle = { off: 'all', all: 'one', one: 'off' };
    cachedToggles = { ...cachedToggles, repeatMode: cycle[cachedToggles.repeatMode] || 'off' };
  }
  cachedTogglesAt = Date.now();
}

function refreshTogglesFromApple() {
  togglesQueryBlockedUntil = 0;
  togglesStale = true;
  const toggles = queryApplePlaybackState();
  if (toggles) {
    cachedToggles = toggles;
    cachedTogglesAt = Date.now();
    togglesStale = false;
  }
}

let toggleRefreshTimer = null;

function scheduleToggleRefresh() {
  clearTimeout(toggleRefreshTimer);
  togglesStale = true;
  togglesQueryBlockedUntil = Date.now() + 2500;
  emitState();
  // ponytail: query UIA while Apple Music is still settling shuffle-off crashes the app
  toggleRefreshTimer = setTimeout(() => {
    toggleRefreshTimer = null;
    refreshTogglesFromApple();
    emitState();
  }, 2000);
}

parentPort.on('message', (msg) => {
  if (msg?.type === 'optimistic-toggle') {
    flipCachedToggle(msg.action);
    togglesStale = true;
    // Block polls from querying while the toggle script holds the UIA mutex
    togglesQueryBlockedUntil = Date.now() + 60000;
    emitState();
    return;
  }
  if (msg?.type === 'revert-toggle') {
    flipCachedToggle(msg.action);
    togglesStale = true;
    togglesQueryBlockedUntil = 0;
    emitState();
    return;
  }
  if (msg?.type === 'invalidate-toggles') {
    scheduleToggleRefresh();
    return;
  }
  if (msg?.type === 'poll') emitState();
});

emitState();
