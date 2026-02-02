export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/proxy") {
      return handleProxy(request, url);
    }

    if (url.pathname === "/sync") {
      return handleSync(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleProxy(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
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

  const hostname = parsed.hostname;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]"
  ) {
    return new Response("Requests to private networks are not allowed", {
      status: 403,
    });
  }

  try {
    const resp = await fetch(target, {
      headers: {
        "User-Agent": "Siphon-Feed-Reader/1.0",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml",
      },
      redirect: "follow",
    });

    const body = await resp.arrayBuffer();

    return new Response(body, {
      status: resp.status,
      headers: {
        ...corsHeaders(),
        "Content-Type": resp.headers.get("Content-Type") || "text/xml",
      },
    });
  } catch (err) {
    return new Response("Fetch failed: " + err.message, {
      status: 502,
      headers: corsHeaders(),
    });
  }
}

const KEY_RE = /^[0-9a-f]{64}$/;
const MAX_BODY = 1024 * 1024; // 1 MB

async function handleSync(request, url, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const key = url.searchParams.get("key");
  if (!key || !KEY_RE.test(key)) {
    return new Response("Invalid or missing key", { status: 400 });
  }

  if (request.method === "GET") {
    const data = await env.SYNC_KV.get(key);
    if (data === null) {
      return new Response("Not found", { status: 404, headers: corsHeaders() });
    }
    return new Response(data, {
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
    return new Response("OK", { status: 200, headers: corsHeaders() });
  }

  return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
