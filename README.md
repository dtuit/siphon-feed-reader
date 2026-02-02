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

## Usage

Open `index.html` in any modern browser. That's it.

Add feeds by clicking the **+** button and entering an RSS or Atom feed URL.

## Hosting with GitHub Pages

You can host Siphon directly using GitHub Pages:

1. Go to your repository **Settings** > **Pages**
2. Under **Source**, select the `master` branch and `/ (root)` folder
3. Rename `siphon-feed-reader.html` to `index.html` (or configure a redirect)
4. Your feed reader will be available at `https://<username>.github.io/siphon-feed-reader/`

## Privacy

Siphon stores everything in your browser's localStorage. No data is sent to any server. Feed requests go directly from your browser to the feed source, with a fallback to a public CORS proxy when direct access is blocked.

## License

[MIT](LICENSE) -- Darren Tuit
