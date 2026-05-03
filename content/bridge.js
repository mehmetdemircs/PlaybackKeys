// PlaybackKeys ISOLATED-world bridge.
// Pipes chrome.runtime messages <-> page (MAIN world) via window.postMessage,
// and announces video presence to the service worker.

(() => {
  const TAG = "playbackkeys";
  const REQ = `${TAG}:req`;
  const RES = `${TAG}:res`;
  const PRESENCE = `${TAG}:presence`;

  if (window.__playbackkeysBridgeInstalled) return;
  window.__playbackkeysBridgeInstalled = true;

  let nextReqId = 1;
  const pending = new Map();
  const isTopFrame = (() => { try { return window === window.top; } catch { return false; } })();

  // chrome.runtime becomes invalid when the user reloads/disables the
  // extension while content scripts are still running in open tabs. After
  // that, every chrome.runtime.* call throws "Extension context invalidated".
  // Detect once and stop trying.
  let extensionAlive = true;
  function isExtensionAlive() {
    if (!extensionAlive) return false;
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) {
        extensionAlive = false;
        return false;
      }
      return true;
    } catch {
      extensionAlive = false;
      return false;
    }
  }
  function safeSendMessage(msg) {
    if (!isExtensionAlive()) return;
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      extensionAlive = false;
    }
  }

  // SW -> page: relay command into MAIN world.
  // Frame coordination: chrome.tabs.sendMessage delivers to every frame and
  // takes the first sendResponse. If a frame here has no video, we don't want
  // to win the race over a sibling frame that does. So:
  //   - handled=true → respond immediately
  //   - handled=false → delay; let any other frame respond first
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // Once the extension context dies (user reloaded the extension while
      // this content script is still alive in the page), every code path
      // that touches the message port can throw. Bail early and silently.
      if (!isExtensionAlive()) return;
      try {
        if (msg?.type !== `${TAG}:command`) return;
        const id = nextReqId++;
        // Wraps sendResponse so an invalid port (after extension reload) is
        // silently swallowed AND we mark the context dead so future paths
        // short-circuit at the early return above.
        const safeRespond = (payload) => {
          if (!isExtensionAlive()) return;
          try { sendResponse(payload); } catch { extensionAlive = false; }
        };
        const timer = setTimeout(() => {
          pending.delete(id);
          safeRespond({ ok: false, reason: "timeout" });
        }, 1500);
        pending.set(id, (resp) => {
          clearTimeout(timer);
          pending.delete(id);
          try {
            const handled = !!(resp && resp.result && resp.result.handled);
            if (handled) {
              safeRespond(resp);
            } else {
              // Delay our "no video here" reply. Iframes get a shorter delay
              // so they can still report back; the top frame waits longest so
              // an iframe with the real video can win.
              const delay = isTopFrame ? 400 : 200;
              setTimeout(() => safeRespond(resp), delay);
            }
          } catch {
            extensionAlive = false;
          }
        });
        window.postMessage({ source: REQ, id, payload: msg.payload, showToast: msg.showToast, prefs: msg.prefs }, "*");
        return true;
      } catch {
        // Listener body threw — most likely the extension context just died.
        // Mark dead so subsequent invocations bail at the early-return above.
        extensionAlive = false;
        return;
      }
    });
  } catch { /* extension context already gone at install time */ }

  // page -> SW relays.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || typeof data !== "object") return;

    if (data.source === RES && pending.has(data.id)) {
      pending.get(data.id)({ ok: true, result: data.result });
      return;
    }

    if (data.source === PRESENCE) {
      // "playing" | "paused" | "gone"
      const map = {
        playing: `${TAG}:video-playing`,
        paused: `${TAG}:video-detected`,
        gone: `${TAG}:video-gone`,
      };
      const type = map[data.state];
      if (type) safeSendMessage({ type });
    }
  });
})();
