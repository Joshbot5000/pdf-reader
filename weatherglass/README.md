# Weatherglass

A focus timer inside a living landscape. Pick a place (lake, beach, forest, meadow),
mix the weather, and the scene and sound follow: trees bend in the gusts you hear,
waves break on screen as they break in your ears, animals wander through. The sky
follows your clock. Every sound is synthesised in the browser: no accounts, no API
keys, no audio files.

## Use it

- **Mac:** open `index.html` in any browser.
- **Phone (installable, works offline):** the page has to be served from a web address.
  With GitHub Pages: repo Settings → Pages → Deploy from a branch → pick the branch
  that holds this folder, folder `/ (root)` → Save. Then open
  `https://<user>.github.io/pdf-reader/weatherglass/` on the phone and choose
  Share → Add to Home Screen (iPhone) or Install app (Android).

Keys: Space start/pause, H hide controls, M sound, F full screen. Tap the sky for lightning.

## Build

Source lives in `src/`. `node weatherglass/build.mjs` writes `app.html` (page body)
and `index.html` (standalone, with the manifest and offline worker).

Tasks and the session log are stored in the browser. To move them between devices,
use Lanterns → Copy transfer code on one and Paste a code on the other.
