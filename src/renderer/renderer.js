/**
 * Renderer — track display, controls, album-art accent color.
 */

/** @type {import('react').RefObject<import('./popover-shell.jsx').PopoverController> | null} */
let animationControllerRef = null;
let ignoreOutsideUntil = 0;

function getPopoverInner() {
  return document.querySelector('.popover__inner');
}

/** @type {HTMLImageElement | null} */
let albumArt = null;
/** @type {HTMLElement | null} */
let albumArtPlaceholder = null;
/** @type {HTMLElement | null} */
let colorBendsMount = null;
/** @type {HTMLElement | null} */
let floatingLinesMount = null;
/** @type {HTMLImageElement | null} */
let albumBlurImage = null;
/** @type {HTMLElement | null} */
let albumBlurPan = null;
/** @type {HTMLElement | null} */
let trackTitle = null;
/** @type {HTMLElement | null} */
let trackArtist = null;
/** @type {HTMLButtonElement | null} */
let btnPrev = null;
/** @type {HTMLButtonElement | null} */
let btnPlay = null;
/** @type {HTMLButtonElement | null} */
let btnNext = null;
/** @type {HTMLButtonElement | null} */
let btnShuffle = null;
/** @type {HTMLButtonElement | null} */
let btnRepeat = null;
/** @type {HTMLButtonElement | null} */
let btnVolDown = null;
/** @type {HTMLButtonElement | null} */
let btnVolUp = null;
/** @type {HTMLButtonElement | null} */
let btnMute = null;
/** @type {HTMLInputElement | null} */
let volumeSlider = null;
/** @type {HTMLInputElement | null} */
let volumeSliderBound = null;

/** @type {import('../types').MediaState | null} */
let currentState = null;
/** @type {boolean | null} */
let pendingShuffle = null;
/** @type {string | null} */
let pendingRepeat = null;
let pendingToggleStartedAt = 0;
const PENDING_TOGGLE_MS = 2000;
let volumeDragging = false;
let volumeSyncPending = false;
let lastVolumeSent = -1;
const accentCanvas = document.createElement('canvas');

const NEUTRAL_ACCENT = {
  accent: '#9a9aa4',
  glow: 'rgba(154, 154, 164, 0.35)',
  ambient1: 'rgba(120, 120, 130, 0.28)',
  ambient2: 'rgba(100, 100, 110, 0.24)',
  ambientBase: 'rgba(90, 90, 100, 0.2)',
};

const NEUTRAL_SHADER = ['#2a2a32', '#32323a', '#242428'];

function setAccentVars({ accent, glow, ambient1, ambient2, ambientBase }) {
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-glow', glow);
  document.documentElement.style.setProperty('--ambient-1', ambient1);
  document.documentElement.style.setProperty('--ambient-2', ambient2);
  if (ambientBase) {
    document.documentElement.style.setProperty('--ambient-base', ambientBase);
  }
}

function extractPaletteFromDataUrl(dataUrl) {
  if (!dataUrl) return;
  const loadId = ++paletteLoadToken;
  const img = new Image();
  img.onload = () => {
    if (loadId !== paletteLoadToken) return;
    sampleAndApply(img);
  };
  img.src = dataUrl;
}

function trackKey(state) {
  return `${state.title}\x00${state.artist}\x00${state.album}\x00${state.trackNumber ?? 0}`;
}

/** @type {string | null} */
let lastDisplayedTrackKey = null;
/** @type {'forward' | 'reverse'} */
let pendingTrackDirection = 'forward';
let metaAnimating = false;
let metaTransitionToken = 0;
const META_TRANSITION_MS = 340;

/**
 * @param {import('../types').MediaState} state
 */
function getTrackTitleText(state) {
  return state.title || 'Not playing';
}

/**
 * @param {import('../types').MediaState} state
 */
function getTrackArtistText(state) {
  return state.active
    ? (state.artist || '').replace(/\s[–—]\s/g, ' - ')
    : 'Open Apple Music to begin';
}

/**
 * @param {string} titleText
 * @param {string} artistText
 */
function setTrackMetaStatic(titleText, artistText) {
  metaTransitionToken += 1;
  metaAnimating = false;
  const titleSlot = document.querySelector('.track__title-slot');
  const artistSlot = document.querySelector('.track__artist-slot');
  if (!titleSlot || !artistSlot) return;

  titleSlot.replaceChildren();
  artistSlot.replaceChildren();

  const titleEl = document.createElement('p');
  titleEl.id = 'track-title';
  titleEl.className = 'track__title';
  titleEl.textContent = titleText;

  const artistEl = document.createElement('p');
  artistEl.id = 'track-artist';
  artistEl.className = 'track__artist';
  artistEl.textContent = artistText;

  titleSlot.appendChild(titleEl);
  artistSlot.appendChild(artistEl);
  trackTitle = titleEl;
  trackArtist = artistEl;
}

/**
 * @param {HTMLElement} slot
 * @param {string} text
 * @param {'track__title' | 'track__artist'} typeClass
 * @param {boolean} forward
 */
function animateMetaSlot(slot, text, typeClass, forward) {
  const outMod = forward ? 'is-outgoing-forward' : 'is-outgoing-reverse';
  const inMod = forward ? 'is-incoming-forward' : 'is-incoming-reverse';
  const existing = slot.querySelector('p');

  if (existing) {
    existing.removeAttribute('id');
    existing.classList.add('track__meta-layer', outMod);
    existing.style.willChange = 'transform, opacity';
  }

  const incoming = document.createElement('p');
  incoming.className = `${typeClass} track__meta-layer ${inMod}`;
  incoming.textContent = text;
  incoming.style.willChange = 'transform, opacity';
  slot.appendChild(incoming);

  void incoming.offsetWidth;
  if (existing) existing.classList.add('is-active');
  incoming.classList.add('is-active');
  return incoming;
}

/**
 * @param {string} titleText
 * @param {string} artistText
 * @param {'forward' | 'reverse'} direction
 */
function runTrackMetaTransition(titleText, artistText, direction) {
  const titleSlot = document.querySelector('.track__title-slot');
  const artistSlot = document.querySelector('.track__artist-slot');
  if (!titleSlot || !artistSlot) {
    setTrackMetaStatic(titleText, artistText);
    return;
  }

  const forward = direction === 'forward';
  const token = ++metaTransitionToken;
  metaAnimating = true;
  const titleIncoming = animateMetaSlot(titleSlot, titleText, 'track__title', forward);
  const artistIncoming = animateMetaSlot(artistSlot, artistText, 'track__artist', forward);

  setTimeout(() => {
    if (token !== metaTransitionToken) return;
    for (const el of titleSlot.querySelectorAll('p')) {
      if (el !== titleIncoming) el.remove();
    }
    for (const el of artistSlot.querySelectorAll('p')) {
      if (el !== artistIncoming) el.remove();
    }

    for (const el of [titleIncoming, artistIncoming]) {
      el.classList.remove(
        'track__meta-layer',
        'is-incoming-forward',
        'is-incoming-reverse',
        'is-active',
      );
      el.style.willChange = '';
    }

    titleIncoming.id = 'track-title';
    artistIncoming.id = 'track-artist';
    trackTitle = titleIncoming;
    trackArtist = artistIncoming;
    metaAnimating = false;

    if (currentState && trackKey(currentState) !== lastDisplayedTrackKey) {
      updateTrackMeta(currentState);
    }
  }, META_TRANSITION_MS);
}

/**
 * @param {import('../types').MediaState} state
 */
function updateTrackMeta(state) {
  const titleText = getTrackTitleText(state);
  const artistText = getTrackArtistText(state);
  const tk = trackKey(state);

  if (!state.active) {
    lastDisplayedTrackKey = tk;
    setTrackMetaStatic(titleText, artistText);
    return;
  }

  if (lastDisplayedTrackKey === null) {
    lastDisplayedTrackKey = tk;
    setTrackMetaStatic(titleText, artistText);
    return;
  }

  if (tk === lastDisplayedTrackKey) return;

  if (metaAnimating) return;

  const direction = pendingTrackDirection;
  pendingTrackDirection = 'forward';
  lastDisplayedTrackKey = tk;
  runTrackMetaTransition(titleText, artistText, direction);
}

function applyThemePalettes(bendsPalette, linesGradient) {
  lastBendsPalette = bendsPalette;
  lastLinesGradient = linesGradient;

  if (currentTheme === 'color-bends') {
    void applyColorBendsBackground(bendsPalette);
  } else if (currentTheme === 'floating-lines') {
    void applyFloatingLinesBackground(linesGradient);
  }

  if (currentTheme === 'album-blur') {
    applyAlbumBlurBackground(lastAlbumArtUrl);
  }
}

function applySampleToUi(sample) {
  const { full, left, right, bendsPalette, linesGradient } = sample;
  const accentFull = vibrantize(full);
  const accentLeft = vibrantize(left);
  const accentRight = vibrantize(right);
  const accentVisible = ensureMinBrightness(accentFull);

  setAccentVars({
    accent: `rgb(${accentVisible.r}, ${accentVisible.g}, ${accentVisible.b})`,
    glow: `rgba(${accentVisible.r}, ${accentVisible.g}, ${accentVisible.b}, 0.45)`,
    ambient1: `rgba(${accentLeft.r}, ${accentLeft.g}, ${accentLeft.b}, 0.38)`,
    ambient2: `rgba(${accentRight.r}, ${accentRight.g}, ${accentRight.b}, 0.34)`,
    ambientBase: `rgba(${accentFull.r}, ${accentFull.g}, ${accentFull.b}, 0.28)`,
  });

  applyThemePalettes(bendsPalette, linesGradient);
}

function sampleAndApply(img) {
  if (!img?.naturalWidth) return false;
  const sample = samplePaletteFromImage(img);
  if (!sample) return false;
  applySampleToUi(sample);
  return true;
}

function applyAlbumArtUrl(dataUrl) {
  if (!dataUrl) return;
  lastAlbumArtUrl = dataUrl;
  updateAlbumArtImage(dataUrl);
  extractPaletteFromDataUrl(dataUrl);
}

/**
 * @param {HTMLImageElement} img
 */
function bindAlbumArtOnload(img) {
  img.onload = () => sampleAndApply(img);
}

/**
 * @param {string} dataUrl
 */
function setAlbumArtStatic(dataUrl) {
  artTransitionToken += 1;
  artAnimating = false;
  const wrap = document.querySelector('.track__art-wrap');
  let img = document.getElementById('album-art');

  if (wrap) {
    for (const layer of wrap.querySelectorAll('.track__art-layer')) {
      if (layer !== img) layer.remove();
    }
  }

  if (!img && wrap) {
    const placeholder = document.getElementById('album-art-placeholder');
    img = document.createElement('img');
    img.id = 'album-art';
    img.className = 'track__art';
    img.alt = '';
    wrap.insertBefore(img, placeholder ?? null);
  }

  if (!img) return;

  img.classList.remove('track__art-layer', 'is-outgoing-fade', 'is-incoming-fade', 'is-active');
  img.style.willChange = '';
  img.hidden = false;
  displayedArtUrl = dataUrl;
  currentArtUrl = dataUrl;
  if (img.src !== dataUrl) img.src = dataUrl;
  albumArt = img;
  bindAlbumArtOnload(img);
}

/**
 * @param {string} dataUrl
 */
function runAlbumArtFade(dataUrl) {
  const wrap = document.querySelector('.track__art-wrap');
  const outgoing = albumArt ?? document.getElementById('album-art');
  if (!wrap || !outgoing) {
    setAlbumArtStatic(dataUrl);
    return;
  }

  const token = ++artTransitionToken;
  artAnimating = true;
  displayedArtUrl = dataUrl;

  outgoing.removeAttribute('id');
  outgoing.classList.add('track__art-layer', 'is-outgoing-fade');
  outgoing.style.willChange = 'opacity';

  const incoming = document.createElement('img');
  incoming.className = 'track__art track__art-layer is-incoming-fade';
  incoming.alt = '';
  incoming.style.willChange = 'opacity';

  const placeholder = document.getElementById('album-art-placeholder');
  wrap.insertBefore(incoming, placeholder ?? null);

  const startFade = () => {
    if (token !== artTransitionToken) return;
    void incoming.offsetWidth;
    outgoing.classList.add('is-active');
    incoming.classList.add('is-active');
  };

  incoming.onload = () => startFade();
  incoming.src = dataUrl;
  if (incoming.complete) startFade();

  setTimeout(() => {
    if (token !== artTransitionToken) return;
    outgoing.remove();
    incoming.classList.remove('track__art-layer', 'is-incoming-fade', 'is-active');
    incoming.style.willChange = '';
    incoming.id = 'album-art';
    albumArt = incoming;
    bindAlbumArtOnload(incoming);
    artAnimating = false;
    currentArtUrl = dataUrl;

    const pending = currentState?.albumArt;
    if (pending && pending !== dataUrl) {
      updateAlbumArtImage(pending);
    }
  }, ART_FADE_MS);
}

/**
 * @param {string} dataUrl
 */
function updateAlbumArtImage(dataUrl) {
  if (!dataUrl) return;

  const img = albumArt ?? document.getElementById('album-art');
  const hasDisplayedArt = displayedArtUrl != null && img && !img.hidden;

  if (!hasDisplayedArt) {
    setAlbumArtStatic(dataUrl);
    return;
  }

  if (dataUrl === displayedArtUrl) return;
  if (artAnimating) return;

  runAlbumArtFade(dataUrl);
}

function clearAlbumArtDisplay() {
  artTransitionToken += 1;
  artAnimating = false;
  displayedArtUrl = null;
  currentArtUrl = null;

  const wrap = document.querySelector('.track__art-wrap');
  if (wrap) {
    for (const layer of wrap.querySelectorAll('.track__art-layer')) {
      layer.remove();
    }
  }

  const img = document.getElementById('album-art');
  if (img) {
    img.removeAttribute('src');
    img.hidden = true;
    img.classList.remove('track__art-layer', 'is-outgoing-fade', 'is-incoming-fade', 'is-active');
    img.style.willChange = '';
    albumArt = img;
  }

  if (albumArtPlaceholder) albumArtPlaceholder.hidden = false;
}

/**
 * @param {import('../types').MediaState} state
 */
function updatePaletteFromState(state) {
  if (!state?.albumArt) {
    clearAlbumColors();
    return;
  }

  lastAlbumArtUrl = state.albumArt;
  updateAlbumArtImage(state.albumArt);
  extractPaletteFromDataUrl(state.albumArt);
}

function scheduleColorRefresh() {
  for (const ms of [150, 400, 800, 1500, 2500, 4000]) {
    setTimeout(() => {
      if (!currentState?.albumArt) return;
      currentArtUrl = null;
      updatePaletteFromState(currentState);
    }, ms);
  }
}
function dominantRegion(data, size, x0, y0, x1, y1) {
  /** @type {Map<number, { n: number, r: number, g: number, b: number }>} */
  const buckets = new Map();

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * size + x) * 4;
      const alpha = data[i + 3];
      if (alpha < 100) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 248 && g > 248 && b > 248) continue;
      if (r < 8 && g < 8 && b < 8) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }
  }

  let best = null;
  let bestScore = -1;
  for (const bucket of buckets.values()) {
    const r = bucket.r / bucket.n;
    const g = bucket.g / bucket.n;
    const b = bucket.b / bucket.n;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // ponytail: count×luminance; upgrade path: k-means on top-quartile pixels
    const score = bucket.n * lum;
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }

  if (!best) return { r: 48, g: 48, b: 52 };
  return {
    r: Math.round(best.r / best.n),
    g: Math.round(best.g / best.n),
    b: Math.round(best.b / best.n),
  };
}

/** @type {'color-bends' | 'simple-gradient' | 'album-blur' | 'floating-lines'} */
let currentTheme = 'color-bends';
/** @type {string[] | null} */
let lastBendsPalette = null;
/** @type {string[] | null} */
let lastLinesGradient = null;
/** @type {string | null} */
let lastAlbumArtUrl = null;
/** @type {string} */
let lastSeenTrackKey = '';
/** @type {string | null} */
let currentArtUrl = null;
/** @type {string | null} */
let displayedArtUrl = null;
let artAnimating = false;
let artTransitionToken = 0;
const ART_FADE_MS = 340;
let paletteLoadToken = 0;

/** @type {ReturnType<import('./color-bends.js').createColorBends> | null} */
let colorBends = null;
/** @type {Promise<ReturnType<import('./color-bends.js').createColorBends>> | null} */
let colorBendsInit = null;
/** @type {ReturnType<import('./floating-lines.js').createFloatingLines> | null} */
let floatingLines = null;
/** @type {Promise<ReturnType<import('./floating-lines.js').createFloatingLines>> | null} */
let floatingLinesInit = null;

const BLUR_DRIFT = { x: -5, y: 5 };
const BLUR_HALF_MS = 10000;
let blurRaf = 0;
let blurStart = 0;

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function vibrantize({ r, g, b }, boost = 1.12) {
  const avg = (r + g + b) / 3;
  return {
    r: Math.min(255, Math.round(avg + (r - avg) * boost)),
    g: Math.min(255, Math.round(avg + (g - avg) * boost)),
    b: Math.min(255, Math.round(avg + (b - avg) * boost)),
  };
}

// Lift dark accents so the active control ring/symbol stay visible.
// No-op when the color is already bright (light covers unchanged).
function ensureMinBrightness({ r, g, b }, minPeak = 180) {
  const peak = Math.max(r, g, b);
  if (peak >= minPeak) return { r, g, b };
  if (peak === 0) return { r: minPeak, g: minPeak, b: minPeak };
  const scale = minPeak / peak;
  return {
    r: Math.round(r * scale),
    g: Math.round(g * scale),
    b: Math.round(b * scale),
  };
}

/** Normalize sampled RGB for shaders — keeps hue, lifts darks, preserves bright samples. */
function albumColorForShader({ r, g, b }) {
  const peak = Math.max(r, g, b, 1);
  const minPeak = 110;
  if (peak >= minPeak) return { r, g, b };
  const scale = minPeak / peak;
  return {
    r: Math.round(r * scale),
    g: Math.round(g * scale),
    b: Math.round(b * scale),
  };
}

function shaderPaletteFromSamples(left, center, right) {
  return [left, center, right].map((c) => rgbToHex(albumColorForShader(c)));
}

function linesGradientFromPalette(palette) {
  if (!palette || palette.length === 0) return null;
  if (palette.length >= 3) return palette.slice(0, 3);
  if (palette.length === 2) return [palette[0], palette[1], palette[0]];
  return [palette[0], palette[0], palette[0]];
}

function samplePaletteFromImage(img) {
  const size = 64;
  accentCanvas.width = size;
  accentCanvas.height = size;
  const ctx = accentCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const third = Math.floor(size / 3);
  const center = dominantRegion(data, size, third, third, size - third - 1, size - third - 1);
  const left = dominantRegion(data, size, 0, 0, third - 1, size - 1);
  const right = dominantRegion(data, size, size - third, 0, size - 1, size - 1);

  const bendsPalette = shaderPaletteFromSamples(left, center, right);
  const linesGradient = linesGradientFromPalette(bendsPalette);

  return {
    full: center,
    left,
    right,
    bendsPalette,
    linesGradient,
  };
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function albumBlurFrame(now) {
  if (!blurStart) blurStart = now;
  const wrap = albumBlurPan.parentElement;
  const w = wrap?.clientWidth || 0;
  const h = wrap?.clientHeight || 0;
  if (!w || !h) {
    blurRaf = requestAnimationFrame(albumBlurFrame);
    return;
  }
  const period = BLUR_HALF_MS * 2;
  const phase = ((now - blurStart) % period) / BLUR_HALF_MS;
  const t = phase <= 1 ? phase : 2 - phase;
  const e = easeInOut(t);
  const x = (BLUR_DRIFT.x * 0.01) * w * e;
  const y = (BLUR_DRIFT.y * 0.01) * h * e;
  albumBlurPan.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  blurRaf = requestAnimationFrame(albumBlurFrame);
}

function startAlbumBlurDrift() {
  if (currentTheme !== 'album-blur' || !albumBlurImage.getAttribute('src')) return;
  cancelAnimationFrame(blurRaf);
  blurStart = 0;
  blurRaf = requestAnimationFrame(albumBlurFrame);
}

function stopAlbumBlurDrift() {
  cancelAnimationFrame(blurRaf);
  blurRaf = 0;
  blurStart = 0;
  albumBlurPan.style.transform = '';
}

async function ensureColorBends() {
  if (colorBends) {
    colorBends.attachTo(colorBendsMount);
    colorBends.resume();
    colorBends.resize();
    return colorBends;
  }
  if (!colorBendsInit) {
    colorBendsInit = (async () => {
      const { createColorBends } = await import('./color-bends.js');
      colorBends = createColorBends(colorBendsMount, {
        rotation: 90,
        speed: 0.2,
        transparent: true,
        autoRotate: 0,
        scale: 1,
        frequency: 1,
        warpStrength: 1,
        mouseInfluence: 0,
        parallax: 0.5,
        noise: 0.12,
        iterations: 1,
        intensity: 1.05,
        bandWidth: 6,
        colors: lastBendsPalette ?? NEUTRAL_SHADER,
      });
      return colorBends;
    })().catch((err) => {
      colorBendsInit = null;
      console.error('[color-bends] init failed:', err);
      throw err;
    });
  }
  return colorBendsInit;
}

function destroyColorBends() {
  if (!colorBends) return;
  colorBends.destroy();
  colorBends = null;
  colorBendsInit = null;
}

async function ensureFloatingLines() {
  if (floatingLines) {
    floatingLines.attachTo(floatingLinesMount);
    floatingLines.resume();
    floatingLines.resize();
    return floatingLines;
  }
  if (!floatingLinesInit) {
    floatingLinesInit = (async () => {
      const { createFloatingLines } = await import('./floating-lines.js');
      floatingLines = createFloatingLines(floatingLinesMount, {
        linesGradient: lastLinesGradient ?? NEUTRAL_SHADER,
        animationSpeed: 1,
        interactive: true,
        bendRadius: 5,
        bendStrength: -0.5,
        mouseDamping: 0.05,
        parallax: true,
        parallaxStrength: 0.2,
      });
      return floatingLines;
    })().catch((err) => {
      floatingLinesInit = null;
      console.error('[floating-lines] init failed:', err);
      throw err;
    });
  }
  return floatingLinesInit;
}

function destroyFloatingLines() {
  if (!floatingLines) return;
  floatingLines.destroy();
  floatingLines = null;
  floatingLinesInit = null;
}

async function applyColorBendsBackground(palette) {
  if (currentTheme !== 'color-bends') return;
  const colors = palette ?? lastBendsPalette;
  if (!colors) return;
  try {
    const cb = await ensureColorBends();
    cb.updateColors(colors);
    cb.resize();
  } catch {
    /* decorative */
  }
}

async function applyFloatingLinesBackground(gradient) {
  if (currentTheme !== 'floating-lines') return;
  const colors = gradient ?? lastLinesGradient;
  if (!colors) return;
  try {
    const fl = await ensureFloatingLines();
    fl.updateGradient(colors);
    fl.resize();
  } catch {
    /* decorative */
  }
}

function applyAlbumBlurBackground(dataUrl) {
  stopAlbumBlurDrift();
  if (currentTheme !== 'album-blur' || !dataUrl) {
    albumBlurImage.removeAttribute('src');
    return;
  }
  const onReady = () => startAlbumBlurDrift();
  albumBlurImage.onload = onReady;
  albumBlurImage.src = dataUrl;
  if (albumBlurImage.complete) onReady();
}

function stopBackgroundEffects() {
  destroyColorBends();
  destroyFloatingLines();
  stopAlbumBlurDrift();
}

// ponytail: close path pauses (keeps the WebGL context + canvas alive) instead of
// destroying, so reopening re-attaches the existing canvas instead of creating a
// new context every time — that churn intermittently exhausted the browser's
// context limit and left the theme blank after close/reopen.
function pauseBackgroundEffects() {
  colorBends?.pause?.();
  floatingLines?.pause?.();
  stopAlbumBlurDrift();
}

function syncBackground() {
  if (currentTheme === 'color-bends') {
    destroyFloatingLines();
    stopAlbumBlurDrift();
    void applyColorBendsBackground(lastBendsPalette);
  } else if (currentTheme === 'floating-lines') {
    destroyColorBends();
    stopAlbumBlurDrift();
    void applyFloatingLinesBackground(lastLinesGradient);
  } else if (currentTheme === 'album-blur') {
    destroyColorBends();
    destroyFloatingLines();
    applyAlbumBlurBackground(lastAlbumArtUrl);
  } else {
    stopBackgroundEffects();
  }
}

/**
 * @param {'color-bends' | 'simple-gradient' | 'album-blur' | 'floating-lines'} theme
 * @param {{ sync?: boolean }} [opts]
 */
function applyTheme(theme, { sync = true } = {}) {
  const valid = ['color-bends', 'simple-gradient', 'album-blur', 'floating-lines'];
  if (!valid.includes(theme)) return;
  currentTheme = theme;
  const popoverInner = getPopoverInner();
  if (popoverInner) popoverInner.dataset.theme = theme;
  if (sync) syncBackground();
}

function clearAlbumColors() {
  lastSeenTrackKey = '';
  currentArtUrl = null;
  lastAlbumArtUrl = null;
  lastBendsPalette = null;
  lastLinesGradient = null;
  paletteLoadToken += 1;
  setAccentVars(NEUTRAL_ACCENT);
  syncBackground();
}

function updatePlayButton(isPlaying) {
  if (!btnPlay) return;
  btnPlay.classList.toggle('is-playing', isPlaying);
  btnPlay.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

function renderPlaybackToggles() {
  if (!btnShuffle || !btnRepeat) return;
  const shuffle = currentState?.shuffleActive ?? false;
  const repeat = currentState?.repeatMode ?? 'off';

  btnShuffle.classList.toggle('is-active', shuffle);
  btnShuffle.setAttribute('aria-label', shuffle ? 'Shuffle on' : 'Shuffle off');
  btnShuffle.setAttribute('aria-pressed', String(shuffle));

  btnRepeat.classList.toggle('is-active', repeat !== 'off');
  btnRepeat.classList.toggle('is-repeat-one', repeat === 'one');
  const repeatLabel = repeat === 'one'
    ? 'Repeat one'
    : repeat === 'all'
      ? 'Repeat all'
      : 'Repeat off';
  btnRepeat.setAttribute('aria-label', repeatLabel);
  btnRepeat.setAttribute('aria-pressed', String(repeat !== 'off'));
}

/**
 * @param {import('../types').MediaState} state
 */
function renderState(state) {
  const pendingFresh = Date.now() - pendingToggleStartedAt < PENDING_TOGGLE_MS;
  if (pendingFresh) {
    if (pendingShuffle !== null) state = { ...state, shuffleActive: pendingShuffle };
    if (pendingRepeat !== null) state = { ...state, repeatMode: pendingRepeat };
  } else {
    pendingShuffle = null;
    pendingRepeat = null;
  }

  if (pendingShuffle !== null && state.shuffleActive === pendingShuffle) pendingShuffle = null;
  if (pendingRepeat !== null && state.repeatMode === pendingRepeat) pendingRepeat = null;

  currentState = state;
  bindDomRefs();

  if (!trackTitle || !trackArtist || !albumArt || !albumArtPlaceholder) return;

  updateTrackMeta(state);

  if (state.albumArt) {
    if (albumArtPlaceholder) albumArtPlaceholder.hidden = true;

    const tk = trackKey(state);
    if (tk !== lastSeenTrackKey) {
      lastSeenTrackKey = tk;
      currentArtUrl = null;
      paletteLoadToken += 1;
    }

    updatePaletteFromState(state);
  } else {
    clearAlbumArtDisplay();
    clearAlbumColors();
  }

  updatePlayButton(state.isPlaying);
  renderPlaybackToggles();

  const disabled = !state.active;
  if (btnPrev) btnPrev.disabled = disabled;
  if (btnPlay) btnPlay.disabled = disabled;
  if (btnNext) btnNext.disabled = disabled;
  if (btnShuffle) btnShuffle.disabled = disabled;
  if (btnRepeat) btnRepeat.disabled = disabled;
}

/**
 * @param {{ volume: number, muted: boolean }} vol
 */
function renderVolume(vol) {
  if (!volumeSlider || !btnMute) return;
  if (!volumeDragging) {
    volumeSlider.value = String(vol.muted ? 0 : vol.volume);
  }
  btnMute.classList.toggle('is-muted', vol.muted);
  btnMute.setAttribute('aria-label', vol.muted ? 'Unmute' : 'Mute');
}

function handleControl(action) {
  if (!currentState?.active) return;

  if (action === 'toggle') {
    updatePlayButton(!currentState.isPlaying);
  } else if (action === 'shuffle') {
    const next = !currentState.shuffleActive;
    currentState = { ...currentState, shuffleActive: next };
    pendingShuffle = next;
    pendingToggleStartedAt = Date.now();
    renderPlaybackToggles();
  } else if (action === 'repeat') {
    const cycle = { off: 'all', all: 'one', one: 'off' };
    const next = cycle[currentState.repeatMode] || 'off';
    currentState = { ...currentState, repeatMode: next };
    pendingRepeat = next;
    pendingToggleStartedAt = Date.now();
    renderPlaybackToggles();
  } else if (action === 'next' || action === 'previous') {
    pendingTrackDirection = action === 'next' ? 'forward' : 'reverse';
    currentArtUrl = null;
    scheduleColorRefresh();
  }

  window.musicController.control(action);
}

async function syncVolumeFromSlider() {
  if (volumeSyncPending || !volumeSlider) return;
  volumeSyncPending = true;
  const value = Number(volumeSlider.value);
  lastVolumeSent = -1;
  try {
    renderVolume(await window.musicController.setVolume(value));
  } catch {
    /* ignore */
  } finally {
    volumeSyncPending = false;
  }
}

function endVolumeDrag(event) {
  if (!volumeDragging) return;
  if (volumeSlider?.hasPointerCapture(event.pointerId)) {
    volumeSlider.releasePointerCapture(event.pointerId);
  }
  void syncVolumeFromSlider().finally(() => {
    volumeDragging = false;
  });
}

function bindVolumeSlider() {
  if (!volumeSlider || volumeSlider === volumeSliderBound) return;
  volumeSliderBound = volumeSlider;

  volumeSlider.addEventListener('pointerdown', (event) => {
    volumeDragging = true;
    volumeSlider.setPointerCapture(event.pointerId);
  });

  volumeSlider.addEventListener('input', () => {
    const value = Number(volumeSlider.value);
    btnMute?.classList.toggle('is-muted', value === 0);
    if (value === lastVolumeSent) return;
    lastVolumeSent = value;
    window.musicController.setVolumeLive(value);
  });

  volumeSlider.addEventListener('pointerup', endVolumeDrag);
  volumeSlider.addEventListener('pointercancel', endVolumeDrag);

  volumeSlider.addEventListener('change', () => {
    if (volumeDragging || volumeSyncPending) return;
    void syncVolumeFromSlider();
  });
}

function bindDomRefs() {
  albumArt = document.getElementById('album-art');
  albumArtPlaceholder = document.getElementById('album-art-placeholder');
  colorBendsMount = document.getElementById('color-bends');
  floatingLinesMount = document.getElementById('floating-lines');
  albumBlurImage = document.querySelector('.album-blur__image');
  albumBlurPan = document.querySelector('.album-blur__pan');
  trackTitle = document.getElementById('track-title');
  trackArtist = document.getElementById('track-artist');
  btnPrev = document.getElementById('btn-prev');
  btnPlay = document.getElementById('btn-play');
  btnNext = document.getElementById('btn-next');
  btnShuffle = document.getElementById('btn-shuffle');
  btnRepeat = document.getElementById('btn-repeat');
  btnVolDown = document.getElementById('btn-vol-down');
  btnVolUp = document.getElementById('btn-vol-up');
  btnMute = document.getElementById('btn-mute');
  volumeSlider = document.getElementById('volume-slider');
  bindVolumeSlider();
  const artEl = document.getElementById('album-art');
  if (artEl) {
    albumArt = artEl;
    bindAlbumArtOnload(artEl);
  }
}

function applyCardLayout(card) {
  if (!card) return;
  document.documentElement.style.setProperty('--card-x', `${card.x}px`);
  document.documentElement.style.setProperty('--card-y', `${card.y}px`);
  document.documentElement.style.setProperty('--card-w', `${card.width}px`);
  document.documentElement.style.setProperty('--card-h', `${card.height}px`);
}

/**
 * @param {import('react').RefObject<{ open: () => void, close: () => Promise<void>, onEnterComplete: (() => void) | null, onExitStart: (() => void) | null }>} controllerRef
 */
export function initRenderer(controllerRef) {
  animationControllerRef = controllerRef;

  const popover = document.getElementById('popover');

  controllerRef.current.onEnterComplete = () => syncBackground();
  controllerRef.current.onExitStart = () => pauseBackgroundEffects();

  window.musicController.onUpdate((state) => renderState(state));
  window.musicController.onArtUpdate((dataUrl) => applyAlbumArtUrl(dataUrl));
  window.musicController.onVolumeUpdate((vol) => renderVolume(vol));
  window.musicController.onThemeUpdate((theme) => applyTheme(theme));

  popover.addEventListener('pointerdown', (event) => {
    if (Date.now() < ignoreOutsideUntil) return;
    if (!event.target.closest('.popover__inner')) {
      window.musicController.dismiss();
    }
  });

  popover.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target?.id) return;

    switch (target.id) {
      case 'btn-prev':
        handleControl('previous');
        break;
      case 'btn-play':
        handleControl('toggle');
        break;
      case 'btn-next':
        handleControl('next');
        break;
      case 'btn-shuffle':
        handleControl('shuffle');
        break;
      case 'btn-repeat':
        handleControl('repeat');
        break;
      case 'btn-vol-down': {
        if (!volumeSlider || !btnMute) return;
        const next = Math.max(0, Number(volumeSlider.value) - 5);
        volumeSlider.value = String(next);
        lastVolumeSent = next;
        btnMute.classList.toggle('is-muted', next === 0);
        window.musicController.adjustVolume(-5);
        break;
      }
      case 'btn-vol-up': {
        if (!volumeSlider || !btnMute) return;
        const next = Math.min(100, Number(volumeSlider.value) + 5);
        volumeSlider.value = String(next);
        lastVolumeSent = next;
        btnMute.classList.toggle('is-muted', next === 0);
        window.musicController.adjustVolume(5);
        break;
      }
      case 'btn-mute': {
        if (!btnMute) return;
        const isMuted = btnMute.classList.contains('is-muted');
        btnMute.classList.toggle('is-muted', !isMuted);
        window.musicController.setMuted(!isMuted);
        break;
      }
      default:
        break;
    }
  });

  window.musicController.onLayout(({ card }) => {
    applyCardLayout(card);
  });

  window.musicController.onRequestOpen(async (payload) => {
    applyCardLayout(payload?.card);
    ignoreOutsideUntil = Date.now() + 350;
    animationControllerRef.current.open();
    bindDomRefs();
    // The persistent window reuses this module state across opens, but React
    // just remounted the content with default text/art. Reset the de-dupe
    // flags so renderState/applyAlbumArtUrl repopulate the fresh DOM.
    lastDisplayedTrackKey = null;
    displayedArtUrl = null;
    if (currentState) renderState(currentState);
    if (currentArtUrl) applyAlbumArtUrl(currentArtUrl);
    try {
      applyTheme(await window.musicController.getTheme(), { sync: false });
    } catch {
      /* use current theme */
    }
    try {
      renderVolume(await window.musicController.getVolume());
    } catch {
      /* volume unavailable */
    }
  });

  window.musicController.onRequestClose(async () => {
    await animationControllerRef.current.close();
  });
}
