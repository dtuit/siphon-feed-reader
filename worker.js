export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/proxy") {
      return handleProxy(request, url);
    }

    if (url.pathname === "/sync") {
      return handleSync(request, url, env);
    }

    const assetResp = await env.ASSETS.fetch(request);
    return new Response(assetResp.body, {
      status: assetResp.status,
      headers: {
        ...Object.fromEntries(assetResp.headers),
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      },
    });
  },
};

function isPrivateIPv4(host) {
  // Block single hex integer (e.g., 0x7f000001 = 127.0.0.1)
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  // Block single decimal integer (e.g., 2130706433 = 127.0.0.1)
  if (/^[0-9]+$/.test(host)) {
    const n = parseInt(host, 10);
    if (n >= 0 && n <= 0xffffffff) return true;
  }

  const parts = host.split(".");
  if (parts.length !== 4) return false;

  // Reject octal (leading zero) or hex notation in any octet
  for (const p of parts) {
    if (/^0x/i.test(p)) return true;
    if (p.length > 1 && p.startsWith("0") && /^\d+$/.test(p)) return true;
  }

  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // 224.0.0.0+ multicast + reserved

  return false;
}

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();

  const blockedHosts = [
    "localhost",
    "0.0.0.0",
    "[::1]",
    "[::]",
    "metadata.google.internal",
    "metadata.internal",
    "instance-data",
  ];
  if (blockedHosts.includes(h)) return true;

  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;

  // Strip IPv6 brackets for numeric checks
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;

  // IPv4-mapped IPv6 like ::ffff:127.0.0.1
  const mappedV4 = bare.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedV4) return isPrivateIPv4(mappedV4[1]);

  // Hex-encoded IPv4-mapped IPv6 like ::ffff:7f00:0001
  const mappedHex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const ipStr =
      ((hi >> 8) & 0xff) + "." + (hi & 0xff) + "." + ((lo >> 8) & 0xff) + "." + (lo & 0xff);
    return isPrivateIPv4(ipStr);
  }

  // IPv6 private ranges
  if (/^fe80:/i.test(bare)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true; // fc00::/7 unique local
  if (bare === "::" || bare === "::1") return true;

  return isPrivateIPv4(bare);
}

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_CONTENT_TYPES = [
  "text/xml",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/json",
];

async function handleProxy(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(request) });
  }

  const target = url.searchParams.get("url");
  if (!target) {
    return new Response("Missing ?url= parameter", { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return new Response("Only HTTP(S) URLs are allowed", { status: 400 });
  }

  if (isPrivateHostname(parsed.hostname)) {
    return new Response("Requests to private networks are not allowed", {
      status: 403,
    });
  }

  try {
    let currentUrl = target;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const resp = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Siphon-Feed-Reader/1.0",
          Accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml",
        },
        redirect: "manual",
      });

      // Handle redirects manually — re-validate hostname at each hop
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const location = resp.headers.get("Location");
        if (!location) {
          return new Response("Redirect with no Location header", {
            status: 502,
            headers: corsHeaders(request),
          });
        }

        let redirectParsed;
        try {
          redirectParsed = new URL(location, currentUrl);
        } catch {
          return new Response("Invalid redirect URL", {
            status: 502,
            headers: corsHeaders(request),
          });
        }

        if (!["http:", "https:"].includes(redirectParsed.protocol)) {
          return new Response("Redirect to non-HTTP protocol blocked", {
            status: 403,
            headers: corsHeaders(request),
          });
        }

        if (isPrivateHostname(redirectParsed.hostname)) {
          return new Response("Redirect to private network blocked", {
            status: 403,
            headers: corsHeaders(request),
          });
        }

        currentUrl = redirectParsed.href;
        continue;
      }

      // Content-Type validation
      const ct = (resp.headers.get("Content-Type") || "").toLowerCase();
      if (ct && !ALLOWED_CONTENT_TYPES.some((t) => ct.includes(t))) {
        return new Response("Unexpected content type", {
          status: 403,
          headers: corsHeaders(request),
        });
      }

      // Response size limit
      const contentLength = resp.headers.get("Content-Length");
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        return new Response("Response too large", {
          status: 413,
          headers: corsHeaders(request),
        });
      }

      const body = await resp.arrayBuffer();
      if (body.byteLength > MAX_RESPONSE_SIZE) {
        return new Response("Response too large", {
          status: 413,
          headers: corsHeaders(request),
        });
      }

      // Validate response looks like a feed (mitigate DNS rebinding)
      const text = new TextDecoder().decode(body);
      if (!/<rss[\s>]|<feed[\s>]|<channel[\s>]|<entry[\s>]/i.test(text)) {
        return new Response("Response does not appear to be a feed", {
          status: 403,
          headers: corsHeaders(request),
        });
      }

      // Always return as text/plain to prevent browser rendering of HTML
      return new Response(body, {
        status: resp.status,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    return new Response("Too many redirects", {
      status: 502,
      headers: corsHeaders(request),
    });
  } catch {
    return new Response("Fetch failed: unable to retrieve the requested resource", {
      status: 502,
      headers: corsHeaders(request),
    });
  }
}

const KEY_RE = /^[0-9a-f]{64}$/;
const MAX_BODY = 1024 * 1024; // 1 MB

async function handleSync(request, url, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(request) });
  }

  const key = url.searchParams.get("key");
  if (!key || !KEY_RE.test(key)) {
    return new Response("Invalid or missing key", { status: 400 });
  }

  if (request.method === "GET") {
    const data = await env.SYNC_KV.get(key);
    if (data === null) {
      return new Response("Not found", { status: 404, headers: corsHeaders(request) });
    }
    return new Response(data, {
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
    });
  }

  if (request.method === "PUT") {
    const contentLength = request.headers.get("Content-Length");
    if (contentLength && parseInt(contentLength) > MAX_BODY) {
      return new Response("Body too large", { status: 413 });
    }
    const body = await request.text();
    if (body.length > MAX_BODY) {
      return new Response("Body too large", { status: 413 });
    }
    try {
      JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    await env.SYNC_KV.put(key, body);
    return new Response("OK", { status: 200, headers: corsHeaders(request) });
  }

  return new Response("Method not allowed", { status: 405, headers: corsHeaders(request) });
}

function corsHeaders(request) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  const origin = request?.headers?.get("Origin");
  if (origin && origin === new URL(request.url).origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}
