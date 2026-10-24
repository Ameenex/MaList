# MaList

A community-driven city portal for Greater Malé — Malé, Hulhumalé Phase 1 and Hulhumalé Phase 2.

Live transit, prayer times, weather, events, a places directory, a crowdsourced price wiki, civic issue reporting, and a guide for visitors.

*Ma* in Dhivehi means "big" (and also "me"), so MaList is the big list.

## Run locally

It's a static site — no build step. Serve the folder over HTTP (the service worker needs it):

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Files

- `index.html` — page markup
- `css/tailwind.css` — precompiled Tailwind utilities; `css/app.css` — the app's own styles and theme
- `js/app.js` — all app logic
- `manifest.webmanifest`, `icons/` — PWA install metadata and icons
- `sw.js` — service worker for offline support (bump `CACHE` when the file list changes)
- `data/data.json` — approved community submissions (written by the approval GitHub Action)
- `data/builtin.json` — official events that always show, plus example content that only fills a list while the community has none (labelled "Example")
- `data/advisories.json` — city advisories with expiry dates

## Deployment

Hosted on GitHub Pages from the `main` branch root.
