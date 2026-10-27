# ChemBrain

The coming-soon website for ChemBrain, a chemistry research workspace in development.

Live website: https://chembrain.pages.dev/

## Website source

`public/index.html` contains the responsive placeholder. The site has no dependencies, server, forms, analytics, API keys, or live publisher/model integrations.

## Cloudflare Pages

This repository is connected to Cloudflare Pages through its Git integration:

- Production branch: `main`
- Framework preset: `None`
- Build command: `exit 0`
- Build output directory: `public`
- Root directory: repository root

Changes pushed to `main` are deployed automatically by Cloudflare Pages. Only the files in `public/` are published. Deployment credentials and personal account information do not belong in this repository.

## Local preview

Run `python3 -m http.server 8000 --directory public` and open `http://localhost:8000`.

The page identifies planned capabilities as work in progress. Replace the placeholder as the application is developed.
