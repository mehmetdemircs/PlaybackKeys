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

  // SW -> page: relay command into MAIN world.
  // Frame coordination: chrome.tabs.sendMessage delivers to every frame and
  // takes the first sendResponse. If a frame here has no video, we don't want
  // to win the race over a sibling frame that does. So:
  //   - handled=true → respond immediately
  //   - handled=false → delay; let any other frame respond first
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== `${TAG}:command`) return;
    const id = nextReqId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      sendResponse({ ok: false, reason: "timeout" });
    }, 1500);
    pending.set(id, (resp) => {
      clearTimeout(timer);
      pending.delete(id);
      const handled = !!resp?.result?.handled;
      if (handled) {
        sendResponse(resp);
      } else {
        // Delay our "no video here" reply. Iframes get a shorter delay so
        // they can still report back; the top frame waits longest so an
        // iframe with the real video can win.
        const delay = isTopFrame ? 400 : 200;
        setTimeout(() => sendResponse(resp), delay);
      }
    });
    window.postMessage({ source: REQ, id, payload: msg.payload, showToast: msg.showToast, prefs: msg.prefs }, "*");
    return true;
  });

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
      if (type) chrome.runtime.sendMessage({ type }).catch(() => {});
    }
  });
})();
