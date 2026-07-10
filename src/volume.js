/**
 * Per-app volume daemon client — Apple Music only (not system volume).
 */

const { spawn } = require('child_process');
const readline = require('readline');
const { fromRoot } = require('./app-root');

const DAEMON_SCRIPT = fromRoot('scripts', 'volume-daemon.ps1');

/** @type {import('child_process').ChildProcess | null} */
let daemon = null;
/** @type {readline.Interface | null} */
let stdoutReader = null;
/** @type {((state: { volume: number, muted: boolean, available?: boolean }) => void) | null} */
let pendingGetResolve = null;
/** @type {Promise<{ volume: number, muted: boolean, available?: boolean }> | null} */
let volumeGetInFlight = null;

function startDaemon() {
  if (daemon) return;

  daemon = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DAEMON_SCRIPT],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );

  daemon.stderr?.on('data', (data) => {
    console.error('[volume-daemon]', data.toString().trim());
  });

  stdoutReader = readline.createInterface({ input: daemon.stdout, terminal: false });
  stdoutReader.on('line', (line) => {
    if (!pendingGetResolve) return;
    const resolve = pendingGetResolve;
    pendingGetResolve = null;
    try {
      const parsed = JSON.parse(line);
      resolve({
        volume: parsed.volume ?? 0,
        muted: parsed.muted ?? false,
        available: parsed.available !== false,
      });
    } catch {
      resolve({ volume: 0, muted: false, available: false });
    }
  });

  daemon.on('exit', () => {
    daemon = null;
    stdoutReader = null;
    pendingGetResolve = null;
    volumeGetInFlight = null;
  });

  daemon.on('error', (err) => {
    console.error('[volume-daemon] error:', err.message);
    daemon = null;
    stdoutReader = null;
    pendingGetResolve = null;
    volumeGetInFlight = null;
  });
}

function write(line) {
  startDaemon();
  if (daemon?.stdin?.writable) {
    daemon.stdin.write(`${line}\n`);
  }
}

/** @type {number | null} */
let pendingLiveVolume = null;
/** @type {NodeJS.Timeout | null} */
let liveFlushTimer = null;

const LIVE_FLUSH_MS = 32;

function flushLiveVolume() {
  if (liveFlushTimer) {
    clearTimeout(liveFlushTimer);
    liveFlushTimer = null;
  }
  if (pendingLiveVolume === null) return;
  const value = pendingLiveVolume;
  pendingLiveVolume = null;
  write(`set ${value}`);
}

function setVolumeLive(volume) {
  pendingLiveVolume = Math.max(0, Math.min(100, Math.round(volume)));
  if (liveFlushTimer) return;
  liveFlushTimer = setTimeout(flushLiveVolume, LIVE_FLUSH_MS);
}

function adjustVolume(delta) {
  write(`adjust ${delta}`);
}

function setMuted(muted) {
  write(`mute ${muted ? 1 : 0}`);
}

function getVolumeState() {
  if (volumeGetInFlight) return volumeGetInFlight;

  startDaemon();
  volumeGetInFlight = new Promise((resolve) => {
    pendingGetResolve = (state) => {
      pendingGetResolve = null;
      volumeGetInFlight = null;
      resolve(state);
    };
    write('get');
    setTimeout(() => {
      if (!pendingGetResolve) return;
      pendingGetResolve = null;
      volumeGetInFlight = null;
      resolve({ volume: 0, muted: false, available: false });
    }, 3000);
  });

  return volumeGetInFlight;
}

async function setVolume(volume) {
  flushLiveVolume();
  write(`set ${Math.max(0, Math.min(100, Math.round(volume)))}`);
  return getVolumeState();
}

function warm() {
  startDaemon();
  getVolumeState().catch(() => {});
}

function shutdown() {
  if (daemon) {
    daemon.kill();
    daemon = null;
    stdoutReader = null;
    pendingGetResolve = null;
    volumeGetInFlight = null;
  }
}

module.exports = {
  getVolumeState,
  setVolume,
  setVolumeLive,
  adjustVolume,
  setMuted,
  warmVolume: warm,
  shutdown,
};
