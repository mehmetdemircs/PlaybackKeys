# PlaybackKeys instructions

PlaybackKeys is a no-build Chromium extension for global video controls.

## Commands

- `pnpm install` installs the optional Playwright smoke-test dependency.
- `pnpm validate` checks the manifest, version alignment, permissions, and
  runtime files.
- `pnpm package` creates the Chrome Web Store archive under `dist/`.
- `pnpm smoke` runs the Chromium runtime smoke test.

## Boundaries

- Keep the extension focused on playback controls for supported video sites.
- Preserve the no-telemetry and no-network product contract.
- Do not widen host permissions or add tracking without an explicit product and
  privacy decision.
- Keep changes local unless a release or publication action is explicitly
  requested.
