# Changelog

All notable changes to PlaybackKeys will be documented in this file.

## [0.4.0] - 2026-05-05

### Changed
- Updated extension description to "Control browser videos with global keyboard shortcuts. Pause, skip, rewind, and change speed without switching tabs."

### Fixed
- Onboarding page CSS now uses design tokens instead of hardcoded dark hex values, so it renders correctly in both light and dark mode

## [0.3.0] - 2026-05-04

### Added
- Windows symbol mappings for improved platform-specific keyboard display
- Landing page and improved documentation

### Changed
- Enhanced content scripts to harden against TrustedHTML CSPs and orphaned context scenarios
- Moved documentation site to `/docs` directory for local loading

### Fixed
- Fixed popup shortcut badge overlap issue

## [0.2.0] - 2026-04-XX

### Added
- Initial stable release
- Global keyboard shortcuts for YouTube, Vimeo, Udemy, and Coursera
- Play/pause, speed control, and skip controls
- Tab targeting logic for multiple open videos
- Speed UI with visual indicator pill
- Extension popup with playback controls
- Settings page for site customization
- Install-time onboarding page

### Features
- No account required
- No telemetry or network requests
- Full privacy — all data stays on device
- Minimal permissions (narrow host permission list by default)
- Per-site opt-in or bulk enable option
