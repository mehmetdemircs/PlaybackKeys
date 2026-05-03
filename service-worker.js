// PlaybackKeys service worker.
// IMPORTANT: chrome.commands.onCommand listener MUST be registered
// synchronously at the top level. Registering inside a promise/callback
// silently fails in MV3.

const SUPPORTED_HOSTS = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtube-nocookie\.com$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)udemy\.com$/i,
  /(^|\.)coursera\.org$/i,
];

const DEFAULTS = {
  seekSeconds: 5,
  speedStep: 0.25,
  speedMin: 0.25,
  speedMax: 4.0,
  wrapSpeed: false,
  showToast: true,
  showBadge: true,
  toastDurationMs: 1500,
  enabledOrigins: {}, // origin -> true (user-enabled per-origin via popup)
  perSiteDisabled: {}, // origin -> true
  runOnAllSites: false,
};

function isSupportedUrl(url, settings) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (settings && settings.runOnAllSites) return true;
  if (SUPPORTED_HOSTS.some((re) => re.test(u.hostname))) return true;
  const enabledOrigins = settings && settings.enabledOrigins;
  return !!(enabledOrigins && enabledOrigins[u.origin]);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function getSession() {
  return chrome.storage.session.get({
    lastVideoTabId: null,
    knownVideoTabs: [], // [{tabId, ts}]
    targetCycleIndex: 0,
  });
}

async function setSession(patch) {
  await chrome.storage.session.set(patch);
}

async function rememberVideoTab(tabId) {
  const { knownVideoTabs } = await getSession();
  const filtered = knownVideoTabs.filter((t) => t.tabId !== tabId);
  filtered.unshift({ tabId, ts: Date.now() });
  await setSession({
    lastVideoTabId: tabId,
    knownVideoTabs: filtered.slice(0, 16),
  });
}

async function forgetVideoTab(tabId) {
  const session = await getSession();
  const knownVideoTabs = session.knownVideoTabs.filter((t) => t.tabId !== tabId);
  const lastVideoTabId = session.lastVideoTabId === tabId ? null : session.lastVideoTabId;
  await setSession({ knownVideoTabs, lastVideoTabId });
}

// Probe: does this tab have a video that's worth targeting? Filters out
// hidden / tiny / decorative / not-yet-loaded elements.
async function tabHasVideo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        for (const v of document.querySelectorAll("video")) {
          const r = v.getBoundingClientRect();
          if (r.width < 80 || r.height < 60) continue;
          // Visible in viewport at all?
          if (r.bottom < 0 || r.right < 0) continue;
          if (r.top > (window.innerHeight || 1e6)) continue;
          if (r.left > (window.innerWidth || 1e6)) continue;
          // Has a usable source?
          if (v.readyState < 1 && !v.currentSrc && !v.src) continue;
          // CSS hidden?
          const cs = getComputedStyle(v);
          if (cs.visibility === "hidden" || cs.display === "none") continue;
          return true;
        }
        return false;
      },
    });
    return results.some((r) => r?.result === true);
  } catch {
    return false;
  }
}

async function pickTargetTab(command) {
  const settings = await getSettings();
  const session = await getSession();

  function isCandidate(tab) {
    if (!tab || !tab.url) return false;
    if (!isSupportedUrl(tab.url, settings)) return false;
    let origin;
    try { origin = new URL(tab.url).origin; } catch { return false; }
    if (settings.perSiteDisabled[origin]) return false;
    return true;
  }

  // If switch-target, cycle through known video tabs that ACTUALLY still
  // have a video (probe each — a cached tab may have navigated away).
  if (command === "7-switch-target") {
    const known = await pruneKnownTabs(session.knownVideoTabs);
    const filtered = [];
    for (const entry of known) {
      const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
      if (isCandidate(tab) && await tabHasVideo(tab.id)) {
        filtered.push({ entry, tab });
      }
    }
    if (filtered.length === 0) return null;
    const idx = (session.targetCycleIndex + 1) % filtered.length;
    await setSession({ targetCycleIndex: idx, lastVideoTabId: filtered[idx].entry.tabId });
    return filtered[idx].tab;
  }

  // 1. Active tab in last-focused window — only if it has a real video.
  // (A user on YouTube home with a video playing in another tab should not
  // hit the home tab.)
  try {
    const lastWin = await chrome.windows.getLastFocused({ populate: false }).catch(() => null);
    const queryOpts = lastWin
      ? { active: true, windowId: lastWin.id }
      : { active: true, lastFocusedWindow: true };
    const [activeTab] = await chrome.tabs.query(queryOpts);
    if (isCandidate(activeTab) && await tabHasVideo(activeTab.id)) {
      return activeTab;
    }
  } catch { /* ignore */ }

  // 2. Audible tabs filtered to supported AND probed for a real video
  // (audio-only sites like Spotify Web make sound but have no controllable
  // <video>).
  const audibleTabs = await chrome.tabs.query({ audible: true });
  const audibleCandidates = audibleTabs.filter(isCandidate);
  const audibleWithVideo = [];
  for (const t of audibleCandidates) {
    if (await tabHasVideo(t.id)) audibleWithVideo.push(t);
  }
  if (audibleWithVideo.length === 1) return audibleWithVideo[0];
  if (audibleWithVideo.length > 1) {
    const lastWin = await chrome.windows.getLastFocused({ populate: false }).catch(() => null);
    if (lastWin) {
      const winner = audibleWithVideo.find((t) => t.windowId === lastWin.id);
      if (winner) return winner;
    }
    return audibleWithVideo[0];
  }

  // 3. Cached lastVideoTabId — re-validate against current settings AND
  // confirm the tab still has a video. Probe once, branch on the result.
  if (session.lastVideoTabId != null) {
    const tab = await chrome.tabs.get(session.lastVideoTabId).catch(() => null);
    if (isCandidate(tab)) {
      const hasVideo = await tabHasVideo(tab.id);
      if (hasVideo) return tab;
      // Stale; forget it so we don't probe again next time.
      await setSession({ lastVideoTabId: null });
    }
  }

  // 4. Any known video tab still alive — filtered AND probed.
  const known = await pruneKnownTabs(session.knownVideoTabs);
  for (const entry of known) {
    const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
    if (isCandidate(tab) && await tabHasVideo(tab.id)) return tab;
  }

  return null;
}

async function pruneKnownTabs(knownVideoTabs) {
  const alive = [];
  for (const entry of knownVideoTabs) {
    const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
    if (tab) alive.push(entry);
  }
  if (alive.length !== knownVideoTabs.length) {
    await setSession({ knownVideoTabs: alive });
  }
  return alive;
}

function commandToAction(command, settings) {
  const speedOpts = {
    min: settings.speedMin,
    max: settings.speedMax,
    wrap: settings.wrapSpeed,
  };
  switch (command) {
    case "1-play-pause":    return { action: "toggle" };
    case "2-speed-up":      return { action: "speed", delta:  settings.speedStep, ...speedOpts };
    case "3-skip-back":     return { action: "seek",  delta: -settings.seekSeconds };
    case "4-skip-forward":  return { action: "seek",  delta:  settings.seekSeconds };
    case "5-speed-down":    return { action: "speed", delta: -settings.speedStep, ...speedOpts };
    case "6-speed-reset":   return { action: "speed", reset: true };
    default:                return null;
  }
}

async function dispatchToTab(tab, payload, opts = {}) {
  const settings = opts.settings || (await getSettings());
  const message = {
    type: "playbackkeys:command",
    payload,
    showToast: opts.showToast !== false && settings.showToast !== false,
    prefs: {
      showToast: settings.showToast !== false,
      showBadge: settings.showBadge !== false,
      toastDurationMs: Number.isFinite(settings.toastDurationMs) ? settings.toastDurationMs : 1500,
    },
  };
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Content script may not be present (e.g. user-enabled origin). Inject and retry.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content/bridge.js"],
        world: "ISOLATED",
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content/injected.js"],
        world: "MAIN",
      });
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (err) {
      console.warn("[PlaybackKeys] Failed to dispatch:", err);
    }
  }
}

// SYNC TOP-LEVEL LISTENER REGISTRATION.
chrome.commands.onCommand.addListener((command) => {
  handleCommand(command).catch((err) =>
    console.warn("[PlaybackKeys] command error:", err)
  );
});

async function handleCommand(command) {
  const settings = await getSettings();
  const tab = await pickTargetTab(command);
  if (!tab) {
    // No target. Open popup to surface state? For now, log only.
    console.info("[PlaybackKeys] No target tab for command:", command);
    return;
  }

  if (command === "7-switch-target") {
    await dispatchToTab(tab, { action: "noop" }, { showToast: true });
    return;
  }

  const action = commandToAction(command, settings);
  if (!action) return;
  await dispatchToTab(tab, action, { showToast: settings.showToast });
}

// Seek the most prominent <video> across all frames in the tab to an absolute
// time. Uses scripting.executeScript directly so we bypass the bridge/MAIN
// messaging race and reliably reach the right frame.
async function seekVideoTo(tabId, absoluteTime) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: (t) => {
        const vids = Array.from(document.querySelectorAll("video"));
        if (vids.length === 0) return false;
        const playing = vids.filter((v) => !v.paused && v.readyState > 1);
        const pool = playing.length > 0 ? playing : vids;
        pool.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        });
        const v = pool[0];
        if (!v) return false;
        const dur = v.duration;
        const seekable = v.seekable;
        const upper = Number.isFinite(dur) && dur > 0
          ? dur
          : (seekable && seekable.length > 0 ? seekable.end(seekable.length - 1) : Infinity);
        const target = Math.max(0, Math.min(upper, t));
        if (!Number.isFinite(target)) return false;
        try { v.currentTime = target; } catch { return false; }
        return true;
      },
      args: [absoluteTime],
    });
    return results.some((r) => r?.result === true);
  } catch (e) {
    console.warn("[PlaybackKeys] seekVideoTo failed:", e);
    return false;
  }
}

// Read the current playback state of the most prominent <video> across all
// frames in the tab. Bypasses the bridge/MAIN messaging entirely so we don't
// race against empty iframes.
async function readVideoStatus(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        const vids = Array.from(document.querySelectorAll("video"));
        if (vids.length === 0) return null;
        const playing = vids.filter((v) => !v.paused && v.readyState > 1);
        const pool = playing.length > 0 ? playing : vids;
        pool.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        });
        const v = pool[0];
        return {
          currentSpeed: v.playbackRate,
          paused: v.paused,
          duration: v.duration || 0,
          currentTime: v.currentTime || 0,
          area: (() => { const r = v.getBoundingClientRect(); return r.width * r.height; })(),
        };
      },
    });
    // executeScript returns an array of { result, frameId }. Pick the frame
    // whose video is biggest (most likely the actual player vs an ad iframe).
    let best = null;
    for (const r of results) {
      if (!r?.result) continue;
      if (!best || r.result.area > best.area) best = r.result;
    }
    if (best) {
      delete best.area;
      return best;
    }
    return null;
  } catch {
    return null;
  }
}

// Content scripts announce themselves on play/pause.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "playbackkeys:get-target") {
    pickTargetTab(null).then((t) =>
      sendResponse(t ? { tabId: t.id, title: t.title, url: t.url } : null)
    );
    return true;
  }
  if (msg?.type === "playbackkeys:get-status") {
    pickTargetTab(null).then(async (t) => {
      if (!t) { sendResponse(null); return; }
      const status = await readVideoStatus(t.id);
      sendResponse({ tabId: t.id, title: t.title, url: t.url, status });
    });
    return true;
  }
  if (msg?.type === "playbackkeys:reset-speed") {
    pickTargetTab(null).then(async (t) => {
      if (!t) { sendResponse(false); return; }
      await dispatchToTab(t, { action: "speed", reset: true });
      sendResponse(true);
    });
    return true;
  }
  if (msg?.type === "playbackkeys:dispatch-command") {
    handleCommand(msg.command).then(() => sendResponse(true)).catch(() => sendResponse(false));
    return true;
  }
  if (msg?.type === "playbackkeys:dispatch-action") {
    pickTargetTab(null).then(async (t) => {
      if (!t) { sendResponse(false); return; }
      await dispatchToTab(t, msg.payload, { showToast: false });
      sendResponse(true);
    });
    return true;
  }
  if (msg?.type === "playbackkeys:seek-to") {
    pickTargetTab(null).then(async (t) => {
      if (!t) { sendResponse(false); return; }
      const ok = await seekVideoTo(t.id, Number(msg.absoluteTime) || 0);
      sendResponse(ok);
    });
    return true;
  }
  if (!sender.tab) return;
  if (msg?.type === "playbackkeys:video-detected" || msg?.type === "playbackkeys:video-playing") {
    // Don't trust the page-side claim alone — a script on the page can spoof
    // these via window.postMessage. Confirm with a real DOM probe before
    // remembering the tab as a target.
    const tabId = sender.tab.id;
    tabHasVideo(tabId).then((real) => {
      if (real) rememberVideoTab(tabId);
    });
  } else if (msg?.type === "playbackkeys:video-gone") {
    forgetVideoTab(sender.tab.id);
  }
});

// Context menu on the toolbar icon (E).
function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "playbackkeys-reset-speed",
      title: "Reset speed to 1x",
      contexts: ["action"],
    });
  });
}
chrome.runtime.onInstalled.addListener(ensureContextMenu);
chrome.runtime.onStartup.addListener(ensureContextMenu);

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "playbackkeys-reset-speed") return;
  const tab = await pickTargetTab(null);
  if (tab) await dispatchToTab(tab, { action: "speed", reset: true });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetVideoTab(tabId);
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
});
