const SUPPORTED_HOSTS = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtube-nocookie\.com$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)udemy\.com$/i,
  /(^|\.)coursera\.org$/i,
];

function detectIsMac() {
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || "";
  if (/mac/i.test(platform)) return true;
  if (/mac|iphone|ipad|ipod/i.test(navigator.platform || "")) return true;
  if (/Macintosh|Mac OS X|iPhone|iPad/i.test(navigator.userAgent || "")) return true;
  return false;
}
const isMac = detectIsMac();

function isBuiltIn(url) {
  try {
    const u = new URL(url);
    return SUPPORTED_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}
function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}
function fmtSpeed(r) { return `${(Math.round(r * 100) / 100).toFixed(2)}×`; }
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function chordToShort(shortcut) {
  if (!shortcut) return "";
  return shortcut.split("+").map((p) => {
    if (isMac) {
      if (p === "Ctrl" || p === "Command") return "⌘";
      if (p === "Shift") return "⇧";
      if (p === "Alt") return "⌥";
      if (p === "MacCtrl") return "⌃";
    } else {
      if (p === "Ctrl") return "^";
      if (p === "Shift") return "⇧";
      if (p === "Alt") return "⌥";
    }
    return p;
  }).join("");
}

let state = {
  tabId: null,
  settings: null,
  status: null,
  pollTimer: null,
  isDragging: false,
  dragFraction: 0,
};

async function fetchStatus() {
  return chrome.runtime.sendMessage({ type: "playbackkeys:get-status" }).catch(() => null);
}
async function fetchSettings() {
  return chrome.storage.local.get({
    seekSeconds: 5,
    speedStep: 0.25,
    speedMin: 0.25,
    speedMax: 4.0,
    perSiteDisabled: {},
    enabledOrigins: {},
    runOnAllSites: false,
  });
}

async function describeEmptyState(activeTab, settings) {
  if (!activeTab?.url || !/^https?:/.test(activeTab.url)) {
    return { title: "No video found", host: "Open a video tab to control it." };
  }
  let url;
  try { url = new URL(activeTab.url); } catch {
    return { title: "No video found", host: "" };
  }
  const builtIn = isBuiltIn(activeTab.url);
  if (builtIn) {
    if (settings.perSiteDisabled[url.origin]) {
      return { title: `${url.hostname} is disabled`, host: "Re-enable it from this menu." };
    }
    return { title: "No video on this page yet", host: "Open a video and try again." };
  }
  if (settings.enabledOrigins[url.origin] || settings.runOnAllSites) {
    return { title: "No video found", host: `On ${url.hostname}` };
  }
  return { title: "Site not enabled", host: `Click "Enable on this site" to use ${url.hostname}.` };
}
async function fetchChords() {
  const cmds = await chrome.commands.getAll();
  const map = {};
  for (const c of cmds) map[c.name] = chordToShort(c.shortcut);
  return map;
}

function applyChords(chordMap) {
  document.querySelectorAll("[data-chord]").forEach((el) => {
    el.textContent = chordMap[el.dataset.chord] || "";
  });
}
function applyLabels(s) {
  document.getElementById("pp-skip-back-amt").textContent = `${s.seekSeconds}s`;
  document.getElementById("pp-skip-fwd-amt").textContent  = `${s.seekSeconds}s`;
  const stepStr = s.speedStep.toFixed(2);
  document.getElementById("pp-down-glyph").textContent = `−${stepStr}`;
  document.getElementById("pp-up-glyph").textContent   = `+${stepStr}`;
}

function applyStatus(status, settings) {
  const titleEl   = document.getElementById("pp-title");
  const hostEl    = document.getElementById("pp-host");
  const stateEl   = document.getElementById("pp-state");
  const speedEl   = document.getElementById("pp-speed");
  const meterEl   = document.getElementById("pp-meter");
  const playGlyph = document.getElementById("pp-play-glyph");
  const playLbl   = document.getElementById("pp-play-lbl");
  const pulse     = document.getElementById("pp-pulse");
  const stateLbl  = document.getElementById("pp-state-label");
  const progressEl = document.getElementById("pp-progress");
  const fillEl    = document.getElementById("pp-progress-fill");
  const handleEl  = document.getElementById("pp-progress-handle");
  const timeEl    = document.getElementById("pp-progress-time");

  const buttons = document.querySelectorAll(".pp-btn");

  // Treat "tab found but no video status" the same as "no target" — the SW
  // gave us a tabId but readVideoStatus() returned null, meaning no playable
  // video element was actually found. We shouldn't pretend we control it.
  const hasRealVideo = status && status.status && typeof status.status.currentSpeed === "number";

  if (!hasRealVideo) {
    // Prefer the precomputed empty-state explanation (init() reads the active
    // tab and decides why); fall back to a generic message.
    if (state.emptyState) {
      titleEl.textContent = state.emptyState.title;
      hostEl.textContent  = state.emptyState.host;
    } else if (status?.title) {
      titleEl.textContent = status.title;
      try { hostEl.textContent = `${new URL(status.url).hostname} · no video found`; }
      catch { hostEl.textContent = "no video found"; }
    } else {
      titleEl.textContent = "No active video tab";
      hostEl.textContent  = "";
    }
    stateEl.textContent = "—";
    speedEl.textContent = "—";
    meterEl.style.width = "0";
    playGlyph.textContent = "▶";
    playLbl.textContent   = "PLAY";
    pulse.classList.add("off");
    stateLbl.textContent  = "Not active";
    buttons.forEach((b) => (b.disabled = true));
    progressEl.hidden = true;
    return;
  }

  buttons.forEach((b) => (b.disabled = false));
  pulse.classList.remove("off");
  stateLbl.textContent = "Controlling";
  state.tabId = status.tabId;

  titleEl.textContent = status.title || "Untitled tab";
  let hostStr = "";
  try { hostStr = new URL(status.url).hostname; } catch {}
  hostEl.textContent = hostStr;

  // Progress bar
  const time = status.status?.currentTime;
  const dur  = status.status?.duration;
  const hasTime = Number.isFinite(time) && time >= 0;
  const hasDur  = Number.isFinite(dur) && dur > 0;

  const barEl = document.getElementById("pp-progress-bar");
  if (hasTime && hasDur) {
    progressEl.hidden = false;
    const frac = state.isDragging ? state.dragFraction : Math.min(1, time / dur);
    if (!state.isDragging) {
      const pct = (frac * 100).toFixed(2);
      fillEl.style.width = `${pct}%`;
      handleEl.style.left = `${pct}%`;
      timeEl.innerHTML = `<span>${fmtTime(time)}</span><span>${fmtTime(dur)}</span>`;
    }
    barEl.setAttribute("aria-valuemin", "0");
    barEl.setAttribute("aria-valuemax", String(Math.round(dur)));
    barEl.setAttribute("aria-valuenow", String(Math.round(time)));
    barEl.setAttribute("aria-valuetext", `${fmtTime(time)} of ${fmtTime(dur)}`);
  } else if (hasTime) {
    progressEl.hidden = false;
    fillEl.style.width = "0";
    handleEl.style.left = "0";
    timeEl.innerHTML = `<span>${fmtTime(time)}</span><span class="live">LIVE</span>`;
    barEl.setAttribute("aria-valuemin", "0");
    barEl.setAttribute("aria-valuemax", "0");
    barEl.setAttribute("aria-valuenow", String(Math.round(time)));
    barEl.setAttribute("aria-valuetext", `${fmtTime(time)} (live)`);
  } else {
    progressEl.hidden = true;
    barEl.removeAttribute("aria-valuemin");
    barEl.removeAttribute("aria-valuemax");
    barEl.removeAttribute("aria-valuenow");
    barEl.removeAttribute("aria-valuetext");
  }

  // Play state
  const paused = status.status?.paused;
  if (typeof paused === "boolean") {
    stateEl.textContent = paused ? "PAUSED" : "PLAYING";
    playGlyph.textContent = paused ? "▶" : "❚❚";
    playLbl.textContent   = paused ? "PLAY" : "PAUSE";
  } else {
    stateEl.textContent   = "—";
    playGlyph.textContent = "⏯";
    playLbl.textContent   = "PLAY";
  }

  // Speed
  const speed = status.status?.currentSpeed;
  if (typeof speed === "number") {
    speedEl.textContent = fmtSpeed(speed);
    speedEl.classList.toggle("active", Math.abs(speed - 1) > 0.01);
    const min = settings.speedMin || 0.25;
    const max = settings.speedMax || 4.0;
    let leftPct, widthPct;
    if (speed >= 1) {
      leftPct = 50;
      widthPct = 50 * Math.min(1, (speed - 1) / Math.max(0.01, (max - 1)));
    } else {
      const ratio = Math.min(1, (1 - speed) / Math.max(0.01, (1 - min)));
      widthPct = 50 * ratio;
      leftPct = 50 - widthPct;
    }
    meterEl.style.left  = `${leftPct}%`;
    meterEl.style.width = `${widthPct}%`;
  } else {
    speedEl.textContent = "—";
    meterEl.style.width = "0";
  }
}

async function dispatchCommand(commandName) {
  await chrome.runtime
    .sendMessage({ type: "playbackkeys:dispatch-command", command: commandName })
    .catch(() => {});
  await refresh(); // immediate refresh after action
}

async function dispatchSeek(absoluteTime) {
  // SW does the seek via chrome.scripting.executeScript directly (same proven
  // path as the status query). Bypasses the bridge race entirely.
  const ok = await chrome.runtime
    .sendMessage({ type: "playbackkeys:seek-to", absoluteTime })
    .catch(() => false);
  if (!ok) console.warn("[PlaybackKeys] seek-to returned false");
  await refresh();
}

async function refresh() {
  const status = await fetchStatus();
  state.status = status;
  applyStatus(status, state.settings);
}

function wireControls() {
  document.querySelectorAll(".pp-btn[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const cmd = btn.dataset.cmd;
      btn.disabled = true;
      try { await dispatchCommand(cmd); } finally { btn.disabled = false; }
    });
  });
}

function wireScrubber() {
  const bar = document.getElementById("pp-progress-bar");
  const fill = document.getElementById("pp-progress-fill");
  const handle = document.getElementById("pp-progress-handle");
  const timeEl = document.getElementById("pp-progress-time");

  function fractionFromClientX(clientX) {
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }
  function paintAt(frac) {
    const pct = (frac * 100).toFixed(2);
    fill.style.width = `${pct}%`;
    handle.style.left = `${pct}%`;
    const dur = state.status?.status?.duration;
    if (Number.isFinite(dur) && dur > 0) {
      timeEl.innerHTML = `<span>${fmtTime(frac * dur)}</span><span>${fmtTime(dur)}</span>`;
    }
  }

  let activePointerId = null;

  bar.addEventListener("pointerdown", (e) => {
    const dur = state.status?.status?.duration;
    if (!Number.isFinite(dur) || dur <= 0) return; // no scrubbing on live streams
    e.preventDefault();
    activePointerId = e.pointerId;
    try { bar.setPointerCapture(e.pointerId); } catch {}
    state.isDragging = true;
    bar.classList.add("dragging");
    state.dragFraction = fractionFromClientX(e.clientX);
    paintAt(state.dragFraction);
  });

  bar.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointerId) return;
    state.dragFraction = fractionFromClientX(e.clientX);
    paintAt(state.dragFraction);
  });

  function endDrag(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    try { bar.releasePointerCapture(e.pointerId); } catch {}
    bar.classList.remove("dragging");
    state.isDragging = false;
    const dur = state.status?.status?.duration;
    if (Number.isFinite(dur) && dur > 0) {
      dispatchSeek(state.dragFraction * dur);
    }
  }
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", endDrag);

  // Keyboard accessibility: arrow keys ±5% when bar is focused.
  bar.addEventListener("keydown", (e) => {
    const dur = state.status?.status?.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const cur = state.status?.status?.currentTime || 0;
    let next = cur;
    if (e.key === "ArrowLeft")       next = Math.max(0, cur - dur * 0.05);
    else if (e.key === "ArrowRight") next = Math.min(dur, cur + dur * 0.05);
    else if (e.key === "Home")       next = 0;
    else if (e.key === "End")        next = dur;
    else return;
    e.preventDefault();
    dispatchSeek(next);
  });
}

async function wireSiteToggle() {
  const ctaWrap = document.getElementById("pp-cta-wrap");
  const toggleBtn = document.getElementById("pp-toggle");
  const lblEl = document.getElementById("pp-toggle-lbl");
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.url || !/^https?:/.test(activeTab.url)) {
    ctaWrap.hidden = true;
    return;
  }
  ctaWrap.hidden = false;
  const url = activeTab.url;
  const builtIn = isBuiltIn(url);
  const origin = new URL(url).origin;
  const hostname = new URL(url).hostname;
  const pattern = originPattern(url);
  const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);

  async function refreshToggle() {
    const { perSiteDisabled = {}, enabledOrigins = {} } =
      await chrome.storage.local.get({ perSiteDisabled: {}, enabledOrigins: {} });

    if (builtIn) {
      const on = !perSiteDisabled[origin];
      toggleBtn.classList.toggle("on", on);
      toggleBtn.setAttribute("aria-checked", String(on));
      lblEl.textContent = `${on ? "Enabled" : "Disabled"} on ${hostname}`;
      toggleBtn.onclick = async () => {
        const cur = (await chrome.storage.local.get({ perSiteDisabled: {} })).perSiteDisabled;
        if (on) cur[origin] = true; else delete cur[origin];
        await chrome.storage.local.set({ perSiteDisabled: cur });
        await refreshToggle();
      };
    } else if (granted) {
      const on = !!enabledOrigins[origin];
      toggleBtn.classList.toggle("on", on);
      toggleBtn.setAttribute("aria-checked", String(on));
      lblEl.textContent = `Enabled on ${hostname}`;
      toggleBtn.onclick = async () => {
        await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
        const { enabledOrigins = {} } = await chrome.storage.local.get({ enabledOrigins: {} });
        delete enabledOrigins[origin];
        await chrome.storage.local.set({ enabledOrigins });
        window.close();
      };
    } else {
      toggleBtn.classList.remove("on");
      toggleBtn.setAttribute("aria-checked", "false");
      lblEl.textContent = `Enable on ${hostname}`;
      toggleBtn.onclick = async () => {
        const ok = await chrome.permissions.request({ origins: [pattern] });
        if (!ok) return;
        const { enabledOrigins = {} } = await chrome.storage.local.get({ enabledOrigins: {} });
        enabledOrigins[origin] = true;
        await chrome.storage.local.set({ enabledOrigins });
        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTab.id, allFrames: true },
            files: ["content/bridge.js"], world: "ISOLATED",
          });
          await chrome.scripting.executeScript({
            target: { tabId: activeTab.id, allFrames: true },
            files: ["content/injected.js"], world: "MAIN",
          });
        } catch { /* ignore */ }
        window.close();
      };
    }
  }
  await refreshToggle();
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (state.isDragging) return; // don't fight the user's drag
    refresh();
  }, 500);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function init() {
  document.getElementById("pp-version").textContent = `v${chrome.runtime.getManifest().version}`;

  const [settings, chords] = await Promise.all([fetchSettings(), fetchChords()]);
  state.settings = settings;
  applyLabels(settings);
  applyChords(chords);

  // Pre-compute an empty-state explanation in case status comes back null.
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.emptyState = await describeEmptyState(activeTab, settings);

  await refresh();

  wireControls();
  wireScrubber();
  await wireSiteToggle();
  startPolling();

  document.getElementById("pp-shortcuts").onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  };
  document.getElementById("pp-settings").onclick = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
}

window.addEventListener("pagehide", stopPolling);
init();
