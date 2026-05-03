---
title: Privacy Policy
---

# Privacy Policy

_Last updated: 2026-05-03_

PlaybackKeys is a browser extension that adds global keyboard
shortcuts for HTML5 video playback.

## What we collect

Nothing.

PlaybackKeys does not collect, transmit, sell, or share any user
data. The extension makes no network requests to any server we
operate or to any third party.

## What is stored locally

The extension keeps the following on your device only, using the
browser's `chrome.storage` API:

- Your preferences (skip interval, speed step, toast visibility,
  per-site enable or disable).
- A short-lived list of tab IDs that contain detected video
  elements, so global shortcuts can target the correct tab. This
  list is cleared when the browser session ends.
- A list of origins you have opted into with the "Enable on this
  site" button.

This data never leaves your device.

## Permissions and why

- **Host permissions** for youtube.com, youtube-nocookie.com,
  vimeo.com, udemy.com, coursera.org. Used to inject the content
  scripts that detect and control video elements on those sites.
- **Optional host permissions** (any site). Only requested if you
  click "Enable on this site" in the popup, and only for that origin.
- **`storage`** to save your preferences locally.
- **`tabs`** to query which tab contains the video to control.
- **`scripting`** to inject the content script into a tab you have
  granted optional permission for.

## Third parties

None. No analytics, no telemetry, no SDKs, no remote code.

## Source code

The full source code is at
https://github.com/mehmetdemircs/PlaybackKeys
so you can verify these claims yourself.

## Contact

For questions or to report an issue, open an issue at the GitHub
repository above.
