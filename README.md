# MaList

A community-driven city portal for Greater Malé — Malé, Hulhumalé Phase 1 and Hulhumalé Phase 2.

Live transit, prayer times, weather, events, a places directory, a crowdsourced price wiki, civic issue reporting, and a guide for visitors.

*Ma* in Dhivehi means "big" (and also "me"), so MaList is the big list.

## How community data works

The site is static. Approved community data lives in [`data/data.json`](data/data.json) and the site reads it on load. Nothing on the page can write to this repo, so there is no token or secret in the site code.

1. Someone adds a place, event or price in the app. It opens a pre-filled GitHub issue (free GitHub account needed). Issues are public.
2. A maintainer reviews the issue and comments `/approve` (or `/reject`).
3. A GitHub Action (`.github/workflows/accept-submission.yml`) checks the data against a strict schema, strips markup, records the GitHub username as the author, and commits it to `data/data.json`. Only users with write access can approve.
4. GitHub Pages republishes the site within a few minutes.

Everything read from the data file is escaped before being shown, and malformed entries are skipped.

## Run locally

It's a static site — no build step. Serve the folder over HTTP (the service worker needs it):

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Files

- `index.html` — the whole app (styles, scripts, icons and PWA manifest are inline)
- `sw.js` — service worker for offline support
- `data/data.json` — approved community submissions
- `.github/` — submission form and the approval Action

## Deployment

Hosted on GitHub Pages from the `main` branch root.
