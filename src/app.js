// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
let feeds = [],
  articles = [],
  activeFeedUrl = null,
  activeArticleIdx = -1,
  currentView = "feeds",
  isLoading = false,
  hideRead = false;
let readSet = new Set(),
  newSet = new Set(),
  knownSet = new Set();
const CACHE_MAX_AGE = 10 * 60 * 1000,
  AUTO_REFRESH_MS = 5 * 60 * 1000;
let autoTimer = null,
  countdownTimer = null,
  nextRefreshAt = 0;

try {
  feeds = JSON.parse(localStorage.getItem("siphon_feeds") || "[]");
} catch {
  feeds = [];
}
try {
  readSet = new Set(JSON.parse(localStorage.getItem("siphon_read") || "[]"));
} catch {}
try {
  hideRead = JSON.parse(localStorage.getItem("siphon_hideread") || "false");
} catch {}
try {
  knownSet = new Set(JSON.parse(localStorage.getItem("siphon_known") || "[]"));
} catch {}
let localTs = 0;
try {
  localTs = JSON.parse(localStorage.getItem("siphon_ts") || "0");
} catch {}
let feedFetchTs = {};
try {
  feedFetchTs = JSON.parse(localStorage.getItem("siphon_fetch_ts") || "{}");
} catch {}
function saveFetchTs() {
  try {
    localStorage.setItem("siphon_fetch_ts", JSON.stringify(feedFetchTs));
  } catch {}
}
function saveTs() {
  localTs = Date.now();
  localStorage.setItem("siphon_ts", JSON.stringify(localTs));
}

function articleKey(a) {
  return a.link || a.title + "||" + a.feedUrl;
}
function isRead(a) {
  return readSet.has(articleKey(a));
}
function isNew(a) {
  return newSet.has(articleKey(a));
}
function markRead(a) {
  const k = articleKey(a);
  if (readSet.has(k)) return;
  readSet.add(k);
  newSet.delete(k);
  saveRead();
  deferSync();
}
function markUnread(a) {
  readSet.delete(articleKey(a));
  saveRead();
  deferSync();
}
function saveRead() {
  const a = [...readSet];
  if (a.length > 5000) readSet = new Set(a.slice(-5000));
  localStorage.setItem("siphon_read", JSON.stringify([...readSet]));
}
function saveKnown() {
  const a = [...knownSet];
  if (a.length > 10000) knownSet = new Set(a.slice(-10000));
  localStorage.setItem("siphon_known", JSON.stringify([...knownSet]));
}
function saveFeeds() {
  localStorage.setItem("siphon_feeds", JSON.stringify(feeds));
}

function toggleHideRead() {
  hideRead = !hideRead;
  localStorage.setItem("siphon_hideread", JSON.stringify(hideRead));
  document.getElementById("hideReadToggle").classList.toggle("on", hideRead);
  exemptKey = null;
  cFiltered = null;
  renderArticleList();
  deferSync();
}

function markAllRead() {
  const src = activeFeedUrl
    ? articles.filter((a) => a.feedUrl === activeFeedUrl)
    : articles;
  src.forEach((a) => {
    markRead(a);
  });
  exemptKey = null;
  cFiltered = null;
  renderArticleList();
  renderFeedList();
}
function markAllReadFeed(url, e) {
  if (e) e.stopPropagation();
  openMenuId = null;
  articles
    .filter((a) => a.feedUrl === url)
    .forEach((a) => {
      markRead(a);
    });
  cFiltered = null;
  renderArticleList();
  renderFeedList();
}

function toggleReadRow(idx, e) {
  e.stopPropagation();
  const f = getFiltered();
  if (idx < 0 || idx >= f.length) return;
  const a = f[idx];
  if (isRead(a)) markUnread(a);
  else markRead(a);
  cFiltered = null;
  lastRange = null;
  renderVisibleRows();
  renderFeedList();
}
function toggleReadInReader() {
  const f = getFiltered();
  if (activeArticleIdx < 0 || activeArticleIdx >= f.length) return;
  const a = f[activeArticleIdx];
  if (isRead(a)) {
    markUnread(a);
    exemptKey = null;
  } else {
    markRead(a);
    exemptKey = articleKey(a);
  }
  cFiltered = null;
  renderOpenArticle();
  lastRange = null;
  renderVisibleRows();
  renderFeedList();
}

// ═══════════════════════════════════════
// FEED CACHE (IndexedDB)
// ═══════════════════════════════════════
let cacheDB = null;
function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("siphon_cache", 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore("feeds");
    };
    req.onsuccess = (e) => {
      cacheDB = e.target.result;
      resolve(cacheDB);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}
async function migrateCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("siphon_c_")) keys.push(k);
  }
  if (!keys.length) return;
  const tx = cacheDB.transaction("feeds", "readwrite");
  const s = tx.objectStore("feeds");
  keys.forEach((k) => {
    try {
      const d = JSON.parse(localStorage.getItem(k));
      s.put(d, k.slice(9));
      localStorage.removeItem(k);
    } catch {
      localStorage.removeItem(k);
    }
  });
  await new Promise((r) => {
    tx.oncomplete = r;
    tx.onerror = r;
  });
}
async function getCache(u) {
  try {
    if (!cacheDB) return null;
    const d = await new Promise((r) => {
      const q = cacheDB
        .transaction("feeds", "readonly")
        .objectStore("feeds")
        .get(u);
      q.onsuccess = () => r(q.result || null);
      q.onerror = () => r(null);
    });
    return d && Date.now() - d.ts <= CACHE_MAX_AGE ? d : null;
  } catch {
    return null;
  }
}
async function setCache(u, t, ic, items, np) {
  try {
    if (!cacheDB) return;
    await new Promise((r) => {
      const tx = cacheDB.transaction("feeds", "readwrite");
      tx.objectStore("feeds").put(
        { ts: Date.now(), t, ic, items, np: np || null },
        u,
      );
      tx.oncomplete = () => r();
      tx.onerror = () => r();
    });
  } catch {}
}
async function delCache(u) {
  try {
    if (!cacheDB) return;
    const tx = cacheDB.transaction("feeds", "readwrite");
    tx.objectStore("feeds").delete(u);
  } catch {}
}
async function getStaleCache(u) {
  try {
    if (!cacheDB) return null;
    return new Promise((r) => {
      const q = cacheDB
        .transaction("feeds", "readonly")
        .objectStore("feeds")
        .get(u);
      q.onsuccess = () => r(q.result || null);
      q.onerror = () => r(null);
    });
  } catch {
    return null;
  }
}
async function loadFromCache() {
  articles = [];
  await Promise.all(
    feeds.map(async (f) => {
      const c = await getStaleCache(f.url);
      if (c) {
        f.title = c.t || f.title;
        f.icon = c.ic || f.icon;
        f.nextPageUrl = c.np || null;
        integrateItems(f.url, c.items, true);
      }
    }),
  );
}

// ═══════════════════════════════════════
// FETCH & PARSE
// ═══════════════════════════════════════
const IS_LOCAL = location.protocol === "file:";
const PROXIES = IS_LOCAL
  ? [(u) => u]
  : [(u) => "/proxy?url=" + encodeURIComponent(u)];
function isWide() {
  return innerWidth >= 900;
}
async function fetchCors(url) {
  for (const p of PROXIES) {
    try {
      const r = await fetch(p(url), { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const t = await r.text();
        if (
          t.includes("<") &&
          (t.includes("<rss") || t.includes("<feed") || t.includes("<channel"))
        )
          return t;
      }
    } catch {}
  }
  throw new Error("CORS blocked or network error");
}
function parseFeed(xml, feedUrl) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid XML");
  const items = [];
  let feedTitle = "",
    feedIcon = "",
    nextPageUrl = null;
  const ch = doc.querySelector("channel");
  if (ch) {
    feedTitle =
      ch.querySelector(":scope>title")?.textContent?.trim() || feedUrl;
    feedIcon = ch.querySelector(":scope>image>url")?.textContent?.trim() || "";
    ch.querySelectorAll("item").forEach((item) => {
      items.push({
        title: item.querySelector("title")?.textContent?.trim() || "Untitled",
        link: item.querySelector("link")?.textContent?.trim() || "",
        description:
          item.querySelector("description")?.textContent?.trim() || "",
        content:
          item
            .querySelector("content\\:encoded,encoded")
            ?.textContent?.trim() ||
          item.querySelector("description")?.textContent?.trim() ||
          "",
        pubDate:
          item.querySelector("pubDate")?.textContent?.trim() ||
          item.querySelector("date")?.textContent?.trim() ||
          "",
        author:
          item.querySelector("author")?.textContent?.trim() ||
          item.querySelector("dc\\:creator,creator")?.textContent?.trim() ||
          "",
        feedUrl,
        feedTitle,
      });
    });
    ch.querySelectorAll("link").forEach((lk) => {
      if (lk.getAttribute("rel") === "next" && lk.getAttribute("href")) {
        try {
          nextPageUrl = new URL(lk.getAttribute("href"), feedUrl).href;
        } catch {}
      }
    });
  }
  const af = doc.querySelector("feed");
  if (!ch && af) {
    feedTitle =
      af.querySelector(":scope>title")?.textContent?.trim() || feedUrl;
    feedIcon = af.querySelector(":scope>icon")?.textContent?.trim() || "";
    af.querySelectorAll("entry").forEach((e) => {
      const lk = e.querySelector('link[rel="alternate"],link:not([rel])');
      items.push({
        title: e.querySelector("title")?.textContent?.trim() || "Untitled",
        link: lk?.getAttribute("href") || "",
        description: e.querySelector("summary")?.textContent?.trim() || "",
        content:
          e.querySelector("content")?.textContent?.trim() ||
          e.querySelector("summary")?.textContent?.trim() ||
          "",
        pubDate:
          e.querySelector("published,updated")?.textContent?.trim() || "",
        author: e.querySelector("author>name")?.textContent?.trim() || "",
        feedUrl,
        feedTitle,
      });
    });
    const nl = af.querySelector(':scope>link[rel="next"]');
    if (nl && nl.getAttribute("href")) {
      try {
        nextPageUrl = new URL(nl.getAttribute("href"), feedUrl).href;
      } catch {}
    }
  }
  if (!ch && !af) throw new Error("Not a valid RSS/Atom feed");
  return { feedTitle, feedIcon, items, nextPageUrl };
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function stripHtml(h) {
  if (!h) return "";
  return h
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}
function fmtDate(s) {
  if (!s) return "";
  try {
    const d = new Date(s);
    if (isNaN(d)) return s;
    const now = new Date(),
      diff = now - d;
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    if (diff < 604800000) return Math.floor(diff / 86400000) + "d ago";
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  } catch {
    return s;
  }
}
function sortT(s) {
  try {
    return new Date(s).getTime() || 0;
  } catch {
    return 0;
  }
}
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escX(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function sanitize(h) {
  if (!h) return "";
  const ALLOWED = new Set([
    "p",
    "div",
    "span",
    "a",
    "img",
    "br",
    "hr",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "em",
    "strong",
    "b",
    "i",
    "u",
    "s",
    "sub",
    "sup",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "figure",
    "figcaption",
    "picture",
    "source",
    "dl",
    "dt",
    "dd",
    "details",
    "summary",
  ]);
  const DANGEROUS = new Set([
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "svg",
    "math",
    "base",
    "meta",
    "link",
    "template",
    "noscript",
    "textarea",
    "select",
    "input",
    "button",
  ]);
  const ATTR_ALLOW = {
    a: new Set(["href"]),
    img: new Set(["src", "alt", "width", "height"]),
    td: new Set(["colspan", "rowspan"]),
    th: new Set(["colspan", "rowspan"]),
    source: new Set(["srcset", "media", "type"]),
  };
  const BAD_SCHEME = /^\s*(javascript|data|vbscript|blob)\s*:/i;
  const d = document.createElement("div");
  d.innerHTML = h;
  function walk(parent) {
    const children = Array.from(parent.childNodes);
    for (const node of children) {
      if (node.nodeType === Node.COMMENT_NODE) {
        parent.removeChild(node);
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE) {
        parent.removeChild(node);
        continue;
      }
      const tag = node.tagName.toLowerCase();
      if (DANGEROUS.has(tag)) {
        parent.removeChild(node);
        continue;
      }
      if (!ALLOWED.has(tag)) {
        walk(node);
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
        continue;
      }
      const allowed = ATTR_ALLOW[tag] || new Set();
      for (const attr of Array.from(node.attributes)) {
        const n = attr.name.toLowerCase();
        if (n.startsWith("on") || !allowed.has(n))
          node.removeAttribute(attr.name);
      }
      if (tag === "a") {
        const href = node.getAttribute("href");
        if (href && BAD_SCHEME.test(href)) node.removeAttribute("href");
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
      if (tag === "img") {
        const src = node.getAttribute("src");
        if (src && BAD_SCHEME.test(src)) node.removeAttribute("src");
        node.setAttribute("referrerpolicy", "no-referrer");
        if (!IS_LOCAL) {
          const imgSrc = node.getAttribute("src");
          if (imgSrc && imgSrc.startsWith("http")) {
            node.dataset.original = imgSrc;
            node.setAttribute(
              "onerror",
              'if(!this.dataset.proxied){this.dataset.proxied=1;this.src="/proxy?url="+encodeURIComponent(this.dataset.original)}',
            );
          }
        }
      }
      if (tag === "source") {
        const srcset = node.getAttribute("srcset");
        if (srcset && BAD_SCHEME.test(srcset)) node.removeAttribute("srcset");
      }
      walk(node);
    }
  }
  walk(d);
  return d.innerHTML;
}
function setLoading(on) {
  isLoading = on;
  document.getElementById("globalLoading").style.display = on ? "flex" : "none";
}
function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

let cFiltered = null,
  cFilterKey = null,
  exemptKey = null;
function getFiltered() {
  const k =
    (activeFeedUrl || "__all__") +
    ":" +
    articles.length +
    ":" +
    hideRead +
    ":" +
    readSet.size +
    ":" +
    (exemptKey || "");
  if (cFilterKey === k && cFiltered) return cFiltered;
  let a = activeFeedUrl
    ? articles.filter((x) => x.feedUrl === activeFeedUrl)
    : articles.slice();
  if (hideRead) {
    const ex = exemptKey;
    a = a.filter((x) => !isRead(x) || articleKey(x) === ex);
  }
  a.sort((x, y) => sortT(y.pubDate) - sortT(x.pubDate));
  cFiltered = a;
  cFilterKey = k;
  return a;
}

// ═══════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════
let _navPush = false;
function navigate(v) {
  const pv = currentView;
  currentView = v;
  if (_navPush && pv !== v) history.pushState({ view: v }, "");
  const fp = document.getElementById("feedsPanel"),
    lp = document.getElementById("listPanel"),
    rp = document.getElementById("readerPanel"),
    ps = document.getElementById("panels");
  if (isWide()) {
    fp.classList.remove("hidden", "hidden-right");
    if (activeArticleIdx >= 0) {
      ps.className = "panels wide-has-reader";
      lp.classList.remove("hidden", "hidden-right");
      rp.classList.remove("hidden", "hidden-right");
    } else {
      ps.className = "panels wide-no-reader";
      lp.classList.remove("hidden", "hidden-right");
      rp.classList.add("hidden-right");
    }
  } else {
    ps.className = "panels";
    fp.classList.toggle("hidden", v !== "feeds");
    fp.classList.remove("hidden-right");
    lp.classList.toggle("hidden", v === "feeds");
    lp.classList.toggle("hidden-right", v === "reader");
    rp.classList.toggle("hidden-right", v !== "reader");
    rp.classList.toggle("hidden", false);
    if (v !== "reader") rp.classList.add("hidden-right");
  }
  updBreadcrumb();
}
function showFeeds() {
  navigate("feeds");
}
function showList() {
  activeArticleIdx = -1;
  exemptKey = null;
  cFiltered = null;
  sessionStorage.setItem(
    "siphon_view",
    JSON.stringify({ feed: activeFeedUrl, article: null }),
  );
  navigate("list");
  renderArticleList();
}
function closeReader() {
  activeArticleIdx = -1;
  exemptKey = null;
  cFiltered = null;
  sessionStorage.setItem(
    "siphon_view",
    JSON.stringify({ feed: activeFeedUrl, article: null }),
  );
  renderArticleList();
  navigate("list");
}
function updBreadcrumb() {
  const el = document.getElementById("breadcrumb");
  let p = [];
  if (isWide() || currentView === "feeds") p = [];
  else if (currentView === "list") {
    p.push('<span class="crumb-link" onclick="showFeeds()">Feeds</span>');
    const l = activeFeedUrl
      ? feeds.find((f) => f.url === activeFeedUrl)?.title || "Feed"
      : "All";
    p.push("<span>" + esc(l) + "</span>");
  } else if (currentView === "reader") {
    p.push('<span class="crumb-link" onclick="showFeeds()">Feeds</span>');
    const l = activeFeedUrl
      ? feeds.find((f) => f.url === activeFeedUrl)?.title || "Feed"
      : "All";
    p.push(
      '<span class="crumb-link" onclick="showList()">' + esc(l) + "</span>",
    );
    p.push("<span>Article</span>");
  }
  el.innerHTML = p.join('<span class="sep">›</span>');
}

// ═══════════════════════════════════════
// ADD / SELECT / REMOVE
// ═══════════════════════════════════════
async function addFeed() {
  const inp = document.getElementById("feedUrl"),
    err = document.getElementById("addError"),
    btn = document.getElementById("addBtn");
  let url = inp.value.trim();
  if (!url) return;
  if (!url.match(/^https?:\/\//)) url = "https://" + url;
  if (feeds.find((f) => f.url === url)) {
    err.textContent = "Already added.";
    return;
  }
  err.textContent = "";
  inp.disabled = true;
  btn.disabled = true;
  btn.textContent = "…";
  setLoading(true);
  try {
    const xml = await fetchCors(url);
    const { feedTitle, feedIcon, items, nextPageUrl } = parseFeed(xml, url);
    feeds.push({
      url,
      title: feedTitle,
      icon: feedIcon,
      nextPageUrl: nextPageUrl || null,
    });
    saveFeeds();
    await setCache(url, feedTitle, feedIcon, items, nextPageUrl);
    items.forEach((a) => knownSet.add(articleKey(a)));
    saveKnown();
    articles = articles.concat(items);
    cFiltered = null;
    inp.value = "";
    renderFeedList();
    selectFeed(url);
    deferSync();
  } catch (e) {
    err.textContent = e.message || "Failed.";
  } finally {
    inp.disabled = false;
    btn.disabled = false;
    btn.textContent = "Add";
    setLoading(false);
    inp.focus();
  }
}
document.getElementById("feedUrl").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addFeed();
});

function selectFeed(u) {
  activeFeedUrl = u;
  activeArticleIdx = -1;
  exemptKey = null;
  cFiltered = null;
  sessionStorage.setItem(
    "siphon_view",
    JSON.stringify({ feed: u, article: null }),
  );
  renderFeedList();
  renderArticleList();
  navigate("list");
}
function removeFeed(u, e) {
  e.stopPropagation();
  openMenuId = null;
  feeds = feeds.filter((f) => f.url !== u);
  saveFeeds();
  delCache(u);
  delete feedFetchTs[u];
  saveFetchTs();
  articles = articles.filter((a) => a.feedUrl !== u);
  if (activeFeedUrl === u) activeFeedUrl = null;
  activeArticleIdx = -1;
  cFiltered = null;
  renderFeedList();
  renderArticleList();
  deferSync();
}

// ═══════════════════════════════════════
// REFRESH
// ═══════════════════════════════════════
let refreshGen = 0,
  renderTimer = null;

function integrateItems(feedUrl, items, isInitial) {
  articles = articles.filter((a) => a.feedUrl !== feedUrl);
  if (!isInitial)
    items.forEach((a) => {
      const k = articleKey(a);
      if (!knownSet.has(k)) newSet.add(k);
    });
  items.forEach((a) => knownSet.add(articleKey(a)));
  articles = articles.concat(items);
}

async function refreshOneFeed(feedUrl, forceNet) {
  const feed = feeds.find((f) => f.url === feedUrl);
  if (!feed) return "skip";
  if (!forceNet) {
    const c = await getCache(feedUrl);
    if (c) {
      feed.title = c.t || feed.title;
      feed.icon = c.ic || feed.icon;
      feed.nextPageUrl = c.np || null;
      integrateItems(feedUrl, c.items, true);
      return "cached";
    }
  }
  try {
    const xml = await fetchCors(feedUrl);
    const r = parseFeed(xml, feedUrl);
    feed.title = r.feedTitle || feed.title;
    feed.icon = r.feedIcon || feed.icon;
    feed.nextPageUrl = r.nextPageUrl || null;
    await setCache(feedUrl, r.feedTitle, r.feedIcon, r.items, r.nextPageUrl);
    feedFetchTs[feedUrl] = Date.now();
    saveFetchTs();
    integrateItems(feedUrl, r.items, !forceNet);
    return "fetched";
  } catch {
    feedFetchTs[feedUrl] = Date.now();
    saveFetchTs();
    const c = await getStaleCache(feedUrl);
    if (c) {
      feed.title = c.t || feed.title;
      feed.icon = c.ic || feed.icon;
      feed.nextPageUrl = c.np || null;
      integrateItems(feedUrl, c.items, true);
      return "stale";
    }
    return "failed";
  }
}

async function refreshAll(forceNet) {
  const gen = ++refreshGen;
  setLoading(true);
  let done = 0;
  const total = feeds.length;
  updStatus(0, total);
  function schedRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (gen !== refreshGen) return;
      cFiltered = null;
      renderFeedList();
      renderArticleList();
    }, 200);
  }
  const ps = feeds.map(async (f) => {
    await refreshOneFeed(f.url, !!forceNet);
    if (gen !== refreshGen) return;
    done++;
    updStatus(done, total);
    schedRender();
  });
  await Promise.allSettled(ps);
  if (gen !== refreshGen) return;
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  saveFeeds();
  saveKnown();
  saveTs();
  cFiltered = null;
  renderFeedList();
  renderArticleList();
  setLoading(false);
  updStatus(-1, 0);
  scheduleAuto();
}

async function refreshStale() {
  const stale = feeds.filter(
    (f) => Date.now() - (feedFetchTs[f.url] || 0) > CACHE_MAX_AGE,
  );
  if (stale.length === 0) {
    scheduleAuto();
    return;
  }
  const gen = ++refreshGen;
  setLoading(true);
  let done = 0;
  const total = stale.length;
  updStatus(0, total);
  function schedRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (gen !== refreshGen) return;
      cFiltered = null;
      renderFeedList();
      renderArticleList();
    }, 200);
  }
  const ps = stale.map(async (f) => {
    await refreshOneFeed(f.url, true);
    if (gen !== refreshGen) return;
    done++;
    updStatus(done, total);
    schedRender();
  });
  await Promise.allSettled(ps);
  if (gen !== refreshGen) return;
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  saveFeeds();
  saveKnown();
  saveTs();
  cFiltered = null;
  renderFeedList();
  renderArticleList();
  setLoading(false);
  updStatus(-1, 0);
  scheduleAuto();
}

async function refreshSingleFeed(feedUrl, e) {
  if (e) e.stopPropagation();
  openMenuId = null;
  const bid = "rf_" + feedUrl.replace(/\W/g, "_");
  const b = document.getElementById(bid);
  if (b) b.classList.add("spinning");
  await refreshOneFeed(feedUrl, true);
  saveFeeds();
  saveKnown();
  cFiltered = null;
  renderFeedList();
  renderArticleList();
  if (b) b.classList.remove("spinning");
}

function updStatus(d, t) {
  const el = document.getElementById("globalLoading");
  if (d < 0) {
    el.style.display = "none";
    return;
  }
  el.style.display = "flex";
  el.innerHTML =
    '<div class="spinner"></div><span class="loading-text">' +
    d +
    "/" +
    t +
    "</span>";
}

// ═══════════════════════════════════════
// PAGINATION
// ═══════════════════════════════════════
const MAX_ITEMS_PER_FEED = 500;
let loadingOlder = false;
async function loadNextPage(feedUrl) {
  const feed = feeds.find((f) => f.url === feedUrl);
  if (!feed || !feed.nextPageUrl) return;
  const visitedPages =
    feed._visitedPages instanceof Set
      ? feed._visitedPages
      : (feed._visitedPages = new Set());
  if (visitedPages.has(feed.nextPageUrl)) return;
  visitedPages.add(feed.nextPageUrl);
  try {
    const xml = await fetchCors(feed.nextPageUrl);
    const r = parseFeed(xml, feedUrl);
    const existingKeys = new Set(
      articles.filter((a) => a.feedUrl === feedUrl).map(articleKey),
    );
    const newItems = r.items.filter((a) => !existingKeys.has(articleKey(a)));
    newItems.forEach((a) => knownSet.add(articleKey(a)));
    articles = articles.concat(newItems);
    feed.nextPageUrl = r.nextPageUrl || null;
    let allFeedItems = articles.filter((a) => a.feedUrl === feedUrl);
    if (allFeedItems.length > MAX_ITEMS_PER_FEED) {
      allFeedItems.sort((a, b) => sortT(b.pubDate) - sortT(a.pubDate));
      const drop = new Set(
        allFeedItems.slice(MAX_ITEMS_PER_FEED).map(articleKey),
      );
      articles = articles.filter(
        (a) => a.feedUrl !== feedUrl || !drop.has(articleKey(a)),
      );
      allFeedItems = allFeedItems.slice(0, MAX_ITEMS_PER_FEED);
    }
    await setCache(
      feedUrl,
      feed.title,
      feed.icon,
      allFeedItems,
      feed.nextPageUrl,
    );
    saveKnown();
    cFiltered = null;
    renderArticleList();
    renderFeedList();
  } catch (e) {
    console.error("Failed to load next page:", e);
  }
}
async function handleLoadOlder() {
  if (loadingOlder || !activeFeedUrl) return;
  loadingOlder = true;
  const btn = document.getElementById("loadOlderBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Loading…";
  }
  await loadNextPage(activeFeedUrl);
  loadingOlder = false;
}

// ═══════════════════════════════════════
// AUTO-REFRESH
// ═══════════════════════════════════════
function scheduleAuto() {
  if (autoTimer) clearTimeout(autoTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  updCountdown();
  countdownTimer = setInterval(updCountdown, 30000);
  autoTimer = setTimeout(
    () => refreshAll(true).then(autoSync),
    AUTO_REFRESH_MS,
  );
}
function updCountdown() {
  const el = document.getElementById("nextRefreshLabel");
  const m = Math.ceil(Math.max(0, nextRefreshAt - Date.now()) / 60000);
  el.textContent = m <= 0 ? "refreshing…" : "refresh in " + m + "m";
}

// ═══════════════════════════════════════
// OPML
// ═══════════════════════════════════════
function exportOpml() {
  let o =
    '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>Siphon</title></head>\n<body>\n';
  feeds.forEach((f) => {
    o +=
      '  <outline type="rss" text="' +
      escX(f.title) +
      '" xmlUrl="' +
      escX(f.url) +
      '" />\n';
  });
  o += "</body>\n</opml>";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([o], { type: "application/xml" }));
  a.download = "siphon-feeds.opml";
  a.click();
}
async function importOpml(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const txt = await file.text();
  const doc = new DOMParser().parseFromString(txt, "text/xml");
  let c = 0;
  doc.querySelectorAll("outline[xmlUrl]").forEach((o) => {
    const u = o.getAttribute("xmlUrl"),
      t = o.getAttribute("text") || o.getAttribute("title") || u;
    if (u && !feeds.find((f) => f.url === u)) {
      feeds.push({ url: u, title: t, icon: "" });
      c++;
    }
  });
  saveFeeds();
  renderFeedList();
  if (c > 0) {
    refreshAll(true);
    deferSync();
  }
  ev.target.value = "";
}

// ═══════════════════════════════════════
// RENDER: FEED LIST
// ═══════════════════════════════════════
const rSvg =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
const xSvg =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const dotsSvg =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const starSvg =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const starFillSvg =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const upSvg =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
const downSvg =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
const markReadSvg =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';

function getSortedFeeds() {
  return feeds.slice().sort((a, b) => {
    const af = a.fav ? 1 : 0,
      bf = b.fav ? 1 : 0;
    if (af !== bf) return bf - af;
    return feeds.indexOf(a) - feeds.indexOf(b);
  });
}

function toggleFav(url, e) {
  if (e) e.stopPropagation();
  openMenuId = null;
  const f = feeds.find((x) => x.url === url);
  if (f) f.fav = !f.fav;
  saveFeeds();
  renderFeedList();
  deferSync();
}

function moveFeed(url, dir, e) {
  if (e) e.stopPropagation();
  openMenuId = null;
  const idx = feeds.findIndex((x) => x.url === url);
  if (idx < 0) return;
  const ni = idx + dir;
  if (ni < 0 || ni >= feeds.length) return;
  [feeds[idx], feeds[ni]] = [feeds[ni], feeds[idx]];
  saveFeeds();
  renderFeedList();
  deferSync();
}

// Drag state
let dragUrl = null;

function onDragStart(url, e) {
  dragUrl = url;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", url);
  setTimeout(() => {
    const el = document.querySelector(
      '[data-feed-url="' + CSS.escape(url) + '"]',
    );
    if (el) el.classList.add("dragging");
  }, 0);
}
function onDragEnd(e) {
  document.querySelectorAll(".feed-item").forEach((el) => {
    el.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
  });
  dragUrl = null;
}
function onDragOver(url, e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  if (url === dragUrl) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  document.querySelectorAll(".feed-item").forEach((el) => {
    el.classList.remove("drag-over-top", "drag-over-bottom");
  });
  if (e.clientY < mid) e.currentTarget.classList.add("drag-over-top");
  else e.currentTarget.classList.add("drag-over-bottom");
}
function onDragLeave(e) {
  e.currentTarget.classList.remove("drag-over-top", "drag-over-bottom");
}
function onDrop(targetUrl, e) {
  e.preventDefault();
  document.querySelectorAll(".feed-item").forEach((el) => {
    el.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
  });
  if (!dragUrl || dragUrl === targetUrl) return;
  const fromIdx = feeds.findIndex((f) => f.url === dragUrl);
  const toIdx = feeds.findIndex((f) => f.url === targetUrl);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = feeds.splice(fromIdx, 1);
  const rect = e.currentTarget.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  const insertIdx =
    e.clientY < mid
      ? feeds.findIndex((f) => f.url === targetUrl)
      : feeds.findIndex((f) => f.url === targetUrl) + 1;
  feeds.splice(insertIdx < 0 ? feeds.length : insertIdx, 0, moved);
  saveFeeds();
  renderFeedList();
  deferSync();
  dragUrl = null;
}

function renderFeedList() {
  const el = document.getElementById("feedList");
  if (!feeds.length) {
    el.innerHTML =
      '<div class="state-message" style="height:auto;padding:30px 16px;"><div class="state-title" style="font-size:16px;">No feeds yet</div><div class="state-desc">Paste a URL above, e.g.<br><code onclick="document.getElementById(\'feedUrl\').value=\'https://hnrss.org/frontpage\';document.getElementById(\'feedUrl\').focus();">hnrss.org/frontpage</code></div></div>';
    return;
  }
  const ac = articles.length,
    au = articles.filter((a) => !isRead(a)).length,
    an = articles.filter((a) => isNew(a)).length;
  const sorted = getSortedFeeds();
  let h = '<div class="feed-section-label">Feeds</div>';
  h +=
    '<div class="feed-item ' +
    (activeFeedUrl === null ? "active" : "") +
    '" onclick="selectFeed(null)">' +
    '<div class="feed-icon-wrap"><div class="feed-icon-circle" style="background:var(--accent);color:var(--bg);font-size:13px;">✦</div></div>' +
    '<div class="feed-info"><div class="feed-name">All Articles</div></div>' +
    '<div class="feed-right">' +
    (an > 0 ? '<span class="new-badge">' + an + "</span>" : "") +
    '<div class="feed-count">' +
    au +
    " / " +
    ac +
    "</div></div></div>";

  let lastWasFav = null;
  sorted.forEach((f, si) => {
    const isFav = !!f.fav;
    if (lastWasFav === null && isFav)
      h += '<div class="feed-section-label">★ Favorites</div>';
    if (lastWasFav === true && !isFav)
      h += '<div class="feed-section-label">All</div>';
    lastWasFav = isFav;

    const fa = articles.filter((a) => a.feedUrl === f.url),
      ct = fa.length,
      ur = fa.filter((a) => !isRead(a)).length,
      fn = fa.filter((a) => isNew(a)).length;
    const init = esc((f.title || "?")[0].toUpperCase()),
      icn = f.icon
        ? '<img src="' +
          esc(f.icon) +
          '" onerror="this.parentElement.textContent=\'' +
          init +
          "'\">"
        : init;
    const mid = "menu_" + f.url.replace(/\W/g, "_");
    const eu = esc(f.url);
    const fidx = feeds.indexOf(f);
    const starBadge =
      '<div class="feed-fav-star' +
      (isFav ? " is-fav" : "") +
      '">' +
      starFillSvg +
      "</div>";
    h +=
      '<div class="feed-item ' +
      (activeFeedUrl === f.url ? "active" : "") +
      '" data-feed-url="' +
      eu +
      '" draggable="true" onclick="selectFeed(\'' +
      eu +
      "')\" ondragstart=\"onDragStart('" +
      eu +
      '\',event)" ondragend="onDragEnd(event)" ondragover="onDragOver(\'' +
      eu +
      '\',event)" ondragleave="onDragLeave(event)" ondrop="onDrop(\'' +
      eu +
      "',event)\">" +
      '<div class="feed-icon-wrap"><div class="feed-icon-circle">' +
      icn +
      "</div>" +
      starBadge +
      "</div>" +
      '<div class="feed-info"><div class="feed-name">' +
      esc(f.title) +
      '</div><div class="feed-url-hint">' +
      esc(hostOf(f.url)) +
      "</div></div>" +
      '<div class="feed-right">' +
      (fn > 0 ? '<span class="new-badge">' + fn + "</span>" : "") +
      '<div class="feed-count">' +
      ur +
      "/" +
      ct +
      "</div>" +
      '<div class="feed-actions">' +
      '<button class="feed-dots" onclick="toggleFeedMenu(\'' +
      mid +
      '\',event)" title="More">' +
      dotsSvg +
      "</button>" +
      '<div class="feed-menu" id="' +
      mid +
      '">' +
      '<button class="feed-menu-item" onclick="toggleFav(\'' +
      eu +
      "',event)\">" +
      (isFav ? starFillSvg + " Unfavorite" : starSvg + " Favorite") +
      "</button>" +
      '<button class="feed-menu-item" onclick="moveFeed(\'' +
      eu +
      "',-1,event)\"" +
      (fidx === 0 ? ' disabled style="opacity:.3;pointer-events:none"' : "") +
      ">" +
      upSvg +
      " Move up</button>" +
      '<button class="feed-menu-item" onclick="moveFeed(\'' +
      eu +
      "',1,event)\"" +
      (fidx === feeds.length - 1
        ? ' disabled style="opacity:.3;pointer-events:none"'
        : "") +
      ">" +
      downSvg +
      " Move down</button>" +
      '<button class="feed-menu-item" onclick="markAllReadFeed(\'' +
      eu +
      "',event)\">" +
      markReadSvg +
      " Mark all read</button>" +
      '<button class="feed-menu-item" onclick="refreshSingleFeed(\'' +
      eu +
      "',event)\">" +
      rSvg +
      " Refresh</button>" +
      '<button class="feed-menu-item danger" onclick="removeFeed(\'' +
      eu +
      "',event)\">" +
      xSvg +
      " Remove</button>" +
      "</div>" +
      "</div>" +
      "</div></div>";
  });
  el.innerHTML = h;
}

let openMenuId = null;
function toggleFeedMenu(id, e) {
  e.stopPropagation();
  // Close any currently open menu
  if (openMenuId && openMenuId !== id) {
    const prev = document.getElementById(openMenuId);
    if (prev) prev.classList.remove("open");
  }
  const menu = document.getElementById(id);
  if (!menu) return;
  const isOpen = menu.classList.toggle("open");
  openMenuId = isOpen ? id : null;
}
// Close menu on any outside click
document.addEventListener("click", () => {
  if (openMenuId) {
    const m = document.getElementById(openMenuId);
    if (m) m.classList.remove("open");
    openMenuId = null;
  }
});

// ═══════════════════════════════════════
// RENDER: ARTICLE LIST (virtual scroll)
// ═══════════════════════════════════════
const RH = 95,
  SH = 34,
  OS = 8;
let lastRange = null,
  layout = [];
function dateBucket(s) {
  if (!s) return "Older";
  try {
    const d = new Date(s);
    if (isNaN(d)) return "Older";
    const n = new Date(),
      t = new Date(n.getFullYear(), n.getMonth(), n.getDate()),
      y = new Date(t);
    y.setDate(t.getDate() - 1);
    const w = new Date(t);
    w.setDate(t.getDate() - 7);
    const m = new Date(t);
    m.setDate(t.getDate() - 30);
    if (d >= t) return "Today";
    if (d >= y) return "Yesterday";
    if (d >= w) return "Last 7 Days";
    if (d >= m) return "Last 30 Days";
    return "Older";
  } catch {
    return "Older";
  }
}
function buildLayout(f) {
  layout = [];
  let y = 0,
    lb = null;
  for (let i = 0; i < f.length; i++) {
    const b = dateBucket(f[i].pubDate);
    if (b !== lb) {
      layout.push({ t: "s", y, h: SH, l: b });
      y += SH;
      lb = b;
    }
    layout.push({ t: "a", y, h: RH, i });
    y += RH;
  }
  return y;
}

function renderArticleList() {
  const le = document.getElementById("articleList"),
    te = document.getElementById("listTitle"),
    ce = document.getElementById("listCount"),
    f = getFiltered();
  document.getElementById("hideReadToggle").classList.toggle("on", hideRead);
  const af = activeFeedUrl
    ? articles.filter((a) => a.feedUrl === activeFeedUrl)
    : articles;
  document.getElementById("unreadBadge").textContent =
    af.filter((a) => !isRead(a)).length + " unread / " + af.length;
  te.textContent = activeFeedUrl
    ? feeds.find((x) => x.url === activeFeedUrl)?.title || "Feed"
    : "All Articles";
  ce.textContent = f.length + " shown";
  if (!f.length) {
    lastRange = null;
    layout = [];
    le.innerHTML =
      '<div class="state-message"><div class="state-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg></div><div class="state-title">' +
      (hideRead ? "All caught up" : "No articles") +
      '</div><div class="state-desc">' +
      (hideRead
        ? 'No unread articles. Toggle "Hide read" to see everything.'
        : "Try refreshing, or the feed may be empty.") +
      "</div></div>";
    return;
  }
  const th = buildLayout(f);
  const feed = activeFeedUrl
    ? feeds.find((x) => x.url === activeFeedUrl)
    : null;
  const olderBtn =
    feed && feed.nextPageUrl
      ? '<div style="padding:16px;text-align:center;"><button class="btn btn-small btn-ghost" id="loadOlderBtn" onclick="handleLoadOlder()">Load older articles</button></div>'
      : "";
  le.innerHTML =
    '<div id="vs" style="height:' +
    th +
    'px;position:relative;"></div>' +
    olderBtn;
  lastRange = null;
  le.removeEventListener("scroll", onScroll);
  le.addEventListener("scroll", onScroll);
  renderVisibleRows();
}
function onScroll() {
  renderVisibleRows();
}

const circSvg =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>';
const checkSvg =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';

function renderVisibleRows() {
  const le = document.getElementById("articleList"),
    sp = document.getElementById("vs");
  if (!sp || !layout.length) return;
  const f = getFiltered(),
    st = le.scrollTop,
    vh = le.clientHeight,
    vt = st - OS * RH,
    vb = st + vh + OS * RH;
  let si = 0,
    ei = layout.length,
    lo = 0,
    hi = layout.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (layout[m].y + layout[m].h < vt) lo = m + 1;
    else hi = m - 1;
  }
  si = Math.max(0, lo - 1);
  lo = si;
  hi = layout.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (layout[m].y > vb) hi = m - 1;
    else lo = m + 1;
  }
  ei = Math.min(layout.length, lo + 1);
  const rk =
    si +
    ":" +
    ei +
    ":" +
    activeArticleIdx +
    ":" +
    f.length +
    ":" +
    readSet.size +
    ":" +
    newSet.size;
  if (lastRange === rk) return;
  lastRange = rk;
  let h = "";
  for (let li = si; li < ei; li++) {
    const it = layout[li];
    if (it.t === "s") {
      h +=
        '<div class="date-section" style="top:' +
        it.y +
        'px;"><span class="date-section-label">' +
        it.l +
        '</span><div class="date-section-line"></div></div>';
    } else {
      const a = f[it.i],
        rd = isRead(a),
        nw = isNew(a),
        cls =
          "article-row" +
          (rd ? " is-read" : "") +
          (nw ? " is-new" : "") +
          (activeArticleIdx === it.i ? " active" : "");
      h +=
        '<div class="' +
        cls +
        '" style="position:absolute;top:' +
        it.y +
        'px;left:0;right:0;" onclick="openArticle(' +
        it.i +
        ')"><div class="article-row-top"><div class="article-row-title">' +
        esc(a.title) +
        "</div>" +
        (nw ? '<span class="new-badge">new</span>' : "") +
        '</div><div class="article-row-meta">' +
        (!activeFeedUrl
          ? '<span class="source">' + esc(a.feedTitle) + "</span>"
          : "") +
        (a.author ? "<span>" + esc(a.author) + "</span>" : "") +
        "<span>" +
        fmtDate(a.pubDate) +
        '</span></div><div class="article-row-snippet">' +
        esc(stripHtml(a.description || a.content).slice(0, 200)) +
        '</div><button class="row-read-btn" onclick="toggleReadRow(' +
        it.i +
        ',event)" title="' +
        (rd ? "Mark unread" : "Mark read") +
        '">' +
        (rd ? checkSvg : circSvg) +
        "</button></div>";
    }
  }
  sp.innerHTML = h;
}

// ═══════════════════════════════════════
// OPEN ARTICLE
// ═══════════════════════════════════════
function openArticle(idx) {
  const f = getFiltered();
  if (idx < 0 || idx >= f.length) return;
  activeArticleIdx = idx;
  const a = f[idx];
  exemptKey = articleKey(a);
  markRead(a);
  newSet.delete(articleKey(a));
  cFiltered = null;
  sessionStorage.setItem(
    "siphon_view",
    JSON.stringify({ feed: activeFeedUrl, article: articleKey(a) }),
  );
  renderOpenArticle();
  lastRange = null;
  renderVisibleRows();
  renderFeedList();
  navigate("reader");
}
function renderOpenArticle() {
  const f = getFiltered();
  if (activeArticleIdx < 0 || activeArticleIdx >= f.length) return;
  const a = f[activeArticleIdx],
    rd = isRead(a);
  const se = document.getElementById("readerScroll");
  document.getElementById("readerHeaderLabel").textContent = esc(a.feedTitle);
  se.innerHTML =
    '<div class="reader-title">' +
    esc(a.title) +
    '</div><div class="reader-meta"><span class="source">' +
    esc(a.feedTitle) +
    "</span>" +
    (a.author ? "<span>" + esc(a.author) + "</span>" : "") +
    "<span>" +
    fmtDate(a.pubDate) +
    '</span><button class="reader-read-toggle" onclick="toggleReadInReader()">' +
    (rd ? "✓ Read — mark unread" : "○ Unread — mark read") +
    "</button></div>" +
    (a.link
      ? '<a class="reader-link" href="' +
        esc(a.link) +
        '" target="_blank" rel="noopener noreferrer">Open original ↗</a>'
      : "") +
    '<div class="reader-content">' +
    sanitize(a.content || a.description) +
    '</div><div class="reader-nav">' +
    (activeArticleIdx > 0
      ? '<button class="btn btn-small btn-ghost" onclick="openArticle(' +
        (activeArticleIdx - 1) +
        ')">← Previous</button>'
      : "") +
    (activeArticleIdx < f.length - 1
      ? '<button class="btn btn-small btn-ghost" onclick="openArticle(' +
        (activeArticleIdx + 1) +
        ')">Next →</button>'
      : "") +
    "</div>";
  se.scrollTop = 0;
}

// ═══════════════════════════════════════
// SYNC
// ═══════════════════════════════════════
async function hashPhrase(p) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey(
    "raw",
    enc.encode(p),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode("siphon-feed-reader-sync-v2"),
      iterations: 600000,
      hash: "SHA-256",
    },
    km,
    256,
  );
  return [...new Uint8Array(bits)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function getSyncPhrase() {
  return (sessionStorage.getItem("siphon_sync_phrase") || "").trim();
}
function saveSyncPhrase(p) {
  sessionStorage.setItem("siphon_sync_phrase", p.trim());
}
function syncStatusMsg(msg) {
  const el = document.getElementById("syncStatus");
  if (el) el.textContent = msg;
}

async function syncPull(key) {
  const r = await fetch("/sync?key=" + key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Sync fetch failed");
  return r.json();
}
async function syncPush(key, data) {
  const r = await fetch("/sync?key=" + key, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error("Sync push failed");
}
function mergeSyncData(local, remote) {
  // Feeds: union by URL
  const localMap = new Map(local.feeds.map((f) => [f.url, f]));
  (remote.feeds || []).forEach((f) => {
    if (!localMap.has(f.url)) localMap.set(f.url, f);
  });
  const mergedFeeds = [...localMap.values()];
  // Read: union, trim to 5000
  const mergedRead = [...new Set([...(remote.read || []), ...local.read])];
  if (mergedRead.length > 5000) mergedRead.splice(0, mergedRead.length - 5000);
  // Known: union, trim to 10000
  const mergedKnown = [...new Set([...(remote.known || []), ...local.known])];
  if (mergedKnown.length > 10000)
    mergedKnown.splice(0, mergedKnown.length - 10000);
  // hideRead: newer timestamp wins
  const mergedHideRead =
    (remote.ts || 0) > (local.ts || 0) ? !!remote.hideRead : local.hideRead;
  return {
    feeds: mergedFeeds,
    read: mergedRead,
    known: mergedKnown,
    hideRead: mergedHideRead,
    ts: Date.now(),
  };
}
async function syncNow() {
  const phrase = document.getElementById("syncPhrase").value.trim();
  if (!phrase) {
    syncStatusMsg("Enter a passphrase.");
    return;
  }
  saveSyncPhrase(phrase);
  syncStatusMsg("Syncing…");
  try {
    const key = await hashPhrase(phrase);
    const local = {
      feeds,
      read: [...readSet],
      known: [...knownSet],
      hideRead,
      ts: Date.now(),
    };
    const remote = await syncPull(key);
    const merged = remote ? mergeSyncData(local, remote) : local;
    feeds = merged.feeds;
    readSet = new Set(merged.read);
    knownSet = new Set(merged.known);
    hideRead = merged.hideRead;
    saveFeeds();
    saveRead();
    saveKnown();
    localStorage.setItem("siphon_hideread", JSON.stringify(hideRead));
    document.getElementById("hideReadToggle").classList.toggle("on", hideRead);
    cFiltered = null;
    renderFeedList();
    renderArticleList();
    await syncPush(key, merged);
    saveTs();
    syncStatusMsg("Synced " + new Date().toLocaleTimeString());
  } catch (e) {
    syncStatusMsg("Sync error: " + e.message);
  }
}
let deferSyncTimer = null;
function deferSync() {
  if (!getSyncPhrase()) return;
  if (deferSyncTimer) clearTimeout(deferSyncTimer);
  deferSyncTimer = setTimeout(() => {
    deferSyncTimer = null;
    autoSync();
  }, 3000);
}
async function autoSync() {
  const phrase = getSyncPhrase();
  if (!phrase) return;
  try {
    const key = await hashPhrase(phrase);
    const local = {
      feeds,
      read: [...readSet],
      known: [...knownSet],
      hideRead,
      ts: Date.now(),
    };
    const remote = await syncPull(key);
    const merged = remote ? mergeSyncData(local, remote) : local;
    feeds = merged.feeds;
    readSet = new Set(merged.read);
    knownSet = new Set(merged.known);
    hideRead = merged.hideRead;
    saveFeeds();
    saveRead();
    saveKnown();
    localStorage.setItem("siphon_hideread", JSON.stringify(hideRead));
    document.getElementById("hideReadToggle").classList.toggle("on", hideRead);
    cFiltered = null;
    renderFeedList();
    renderArticleList();
    await syncPush(key, merged);
    saveTs();
    syncStatusMsg("Synced " + new Date().toLocaleTimeString());
  } catch (e) {
    syncStatusMsg("Auto-sync error: " + (e.message || "unknown"));
  }
}

async function initSync() {
  const phrase = getSyncPhrase();
  if (phrase) {
    try {
      syncStatusMsg("Syncing…");
      const key = await hashPhrase(phrase);
      const remote = await syncPull(key);
      if (remote && (remote.ts || 0) > localTs) {
        const local = {
          feeds,
          read: [...readSet],
          known: [...knownSet],
          hideRead,
          ts: localTs,
        };
        const merged = mergeSyncData(local, remote);
        feeds = merged.feeds;
        readSet = new Set(merged.read);
        knownSet = new Set(merged.known);
        hideRead = merged.hideRead;
        saveFeeds();
        saveRead();
        saveKnown();
        localStorage.setItem("siphon_hideread", JSON.stringify(hideRead));
        document
          .getElementById("hideReadToggle")
          .classList.toggle("on", hideRead);
        await loadFromCache();
        cFiltered = null;
        renderFeedList();
        renderArticleList();
      }
      const pushData = {
        feeds,
        read: [...readSet],
        known: [...knownSet],
        hideRead,
        ts: Date.now(),
      };
      await syncPush(key, pushData);
      saveTs();
      syncStatusMsg("Synced " + new Date().toLocaleTimeString());
    } catch (e) {
      syncStatusMsg("Sync error: " + (e.message || "unknown"));
    }
  }
  await refreshStale();
}

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
window.addEventListener("resize", () => navigate(currentView));
document.getElementById("hideReadToggle").classList.toggle("on", hideRead);
document.getElementById("syncPhrase").value = getSyncPhrase();
if (getSyncPhrase()) syncStatusMsg("Passphrase saved. Will sync on refresh.");
renderFeedList();
(async () => {
  try {
    await openCacheDB();
    await migrateCache();
  } catch {}
  if (feeds.length > 0) {
    let sv = null;
    try {
      sv = JSON.parse(sessionStorage.getItem("siphon_view"));
    } catch {}
    activeFeedUrl = sv?.feed ?? null;
    activeArticleIdx = -1;
    await loadFromCache();
    cFiltered = null;
    if (sv?.article) {
      const f = getFiltered();
      const ri = f.findIndex((a) => articleKey(a) === sv.article);
      if (ri >= 0) {
        openArticle(ri);
      } else {
        renderFeedList();
        renderArticleList();
        navigate("list");
      }
    } else {
      renderFeedList();
      renderArticleList();
      navigate("list");
    }
    initSync();
  } else {
    navigate("feeds");
    initSync();
  }
})();
history.replaceState({ view: "feeds" }, "");
if (currentView !== "feeds") history.pushState({ view: currentView }, "");
_navPush = true;
window.addEventListener("popstate", (e) => {
  _navPush = false;
  const v = e.state?.view || "feeds";
  if (v === "reader" && activeArticleIdx >= 0) navigate("reader");
  else if (v === "list") showList();
  else showFeeds();
  _navPush = true;
});
