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

- `index.html` — the whole app (styles, scripts, icons and PWA manifest are inline)
- `sw.js` — service worker for offline support

## Deployment

Hosted on GitHub Pages from the `main` branch root.
