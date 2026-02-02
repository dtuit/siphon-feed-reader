# Siphon

A lightweight, privacy-focused RSS/Atom feed reader that runs entirely in your browser.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **No backend required** -- all data stays in your browser via localStorage
- **Single HTML file** -- no build step, no dependencies, no frameworks
- **RSS 2.0 and Atom** feed support
- **OPML import/export** for migrating feeds between readers
- **Auto-refresh** with configurable intervals
- **Read/unread tracking** with hide-read filtering
- **Drag-and-drop** feed reordering
- **Responsive design** -- works on desktop and mobile
- **Dark theme** with a clean, modern UI
- **Cross-browser sync** via Cloudflare Workers KV (optional, passphrase-based)

## Usage

Open `public/index.html` in any modern browser to use Siphon locally. Feeds are fetched directly, with a fallback to `corsproxy.io` for CORS-blocked sources.

Add feeds by clicking the **+** button and entering an RSS or Atom feed URL.

## Deploy to Cloudflare

Siphon deploys as a single Cloudflare Workers project that serves the static app and proxies feed requests (avoiding CORS issues).

1. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm install -g wrangler`
2. Authenticate: `wrangler login`
3. Deploy:
   ```bash
   wrangler deploy
   ```
4. Your feed reader will be available at `https://siphon-feed-reader.<you>.workers.dev`

The Cloudflare Workers free tier includes 100,000 requests per day.

## Sync across browsers

Siphon can sync your feeds, read state, and preferences across browsers using Cloudflare Workers KV.

The KV namespace is already configured in `wrangler.toml`. To enable sync:

1. Enter a passphrase in the **Sync** section at the bottom of the feeds panel
2. Click **Sync** (or it syncs automatically on each feed refresh)
3. Use the same passphrase in another browser to sync

Data is stored in KV keyed by a SHA-256 hash of your passphrase. Anyone who knows the passphrase can read and overwrite the synced data -- choose something unique.

## Privacy

Siphon stores everything in your browser's localStorage. No data is sent to any server other than the feed sources themselves (proxied through the Cloudflare Worker when deployed, or `corsproxy.io` when opened locally). If you enable sync, your feed list and read state are stored in Cloudflare Workers KV, encrypted by passphrase hash.

## License

[MIT](LICENSE) -- Darren Tuit
