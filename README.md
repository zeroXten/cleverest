# CLEVEREST — EV calculator

A tiny, mobile-first EV charging calculator. Add your car once, then use the
sliders to see **how long** a charge will take, **when** it'll be ready,
**how much** it'll cost, and **how far** you'll be able to drive.

Pure static HTML/CSS/JS — no build step, no server, no accounts. Your cars are
saved in the browser (`localStorage`). It's a PWA, so it can be installed to
an Android/desktop home screen and works offline.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup for both views (calculator + car manager) |
| `styles.css` | All styling (dark neon theme) |
| `app.js` | Calculator maths, car storage, install button, SW registration |
| `manifest.webmanifest` | PWA metadata (name, icons, colours) |
| `sw.js` | Service worker — caches the app shell for offline use |
| `icons/` | App icons (192/512 + maskable + apple-touch + favicon) |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |

## Run locally

Service workers need `http`/`https` (not `file://`), so serve the folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000

## Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "CLEVEREST"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Build and deployment → Source: Deploy
from a branch → Branch: `main` / root**. Your app appears at
`https://<you>.github.io/<repo>/`.

All asset paths are relative, so it works from that sub-path with no changes.

## Install as an app

Open the site in Chrome on Android (or desktop Chrome/Edge) and tap the
**Install app** button — it appears once the browser confirms the app is
installable. On iOS Safari there's no install prompt, so the app shows a hint:
**Share → Add to Home Screen**.

## The maths

- `energy = battery × (target% − now%)`
- `time = energy ÷ min(chargerSpeed, carMaxRate) ÷ 0.9` (0.9 = a rough charging-efficiency allowance)
- `ready by = now + time`
- `cost = energy × price`
- `range = battery × charge% × efficiency`

These are deliberately simple estimates. Real charging slows as the battery
fills (especially past ~80%), so treat the numbers as a good ballpark.
