# WP&R Adoptable Pets Widget — Scraper

Automated data pipeline for the Wausau Pilot & Review adoptable pets widget.

## How it works

```
furrypets.com ──────→ Puppeteer (headless Chrome)
adoptapet.com ──────→ HTML scrape              ──→ pet-data.json ──→ GitHub Pages ──→ Widget
petfinder.com ──────→ HTML scrape
```

The scraper runs every 6 hours via GitHub Actions, pulling current pet listings from:

| Shelter | Source | Method |
|---------|--------|--------|
| Marathon County HS | Adoptapet.com | HTML scrape |
| Clark County HS | Petfinder.com | HTML scrape |
| Adams County HS | Adoptapet.com | HTML scrape |
| Lincoln County HS | furrypets.com | Puppeteer (dynamic JS) |

## Quick start

```bash
cd scraper
npm install
node build-widget-data.js
```

This outputs `pet-data.json` which the widget consumes.

## GitHub Actions setup

1. Create a new GitHub repo
2. Copy this entire `scraper/` folder into it
3. Copy `.github/workflows/update-pets.yml` into the repo root
4. Enable GitHub Pages (Settings → Pages → Deploy from branch → `main` → `/docs`)
5. The workflow runs automatically every 6 hours, or trigger manually from Actions tab

## Updating the widget

Once the scraper is running and `pet-data.json` is on GitHub Pages, update the widget HTML to fetch from:

```javascript
const PROXY_URL = 'https://YOUR-USERNAME.github.io/YOUR-REPO/pet-data.json';
```

The widget already has this config option built in — just set `CONFIG.PROXY_URL` or modify the `loadData()` function to fetch from this URL.

## Adding a new shelter

1. Add a scraper function in `build-widget-data.js` (use `scrapeAdoptapet()` as a template for aggregator sites, or `scrapeLincoln()` for sites that need Puppeteer)
2. Add the shelter config in the widget HTML
3. Test locally with `node build-widget-data.js`
