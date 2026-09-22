// This Worker only does two GDAL-free jobs: resolve a pasted WMS/WCS URL
// into concrete request parameters (service/layer/CRS/area/resolution), and
// proxy the raw bytes of a WMS/WCS request so the browser can read them
// regardless of the origin server's own CORS policy. The actual raster
// clip/mosaic/reproject work runs client-side via gdal3.js (see
// web/gdal-runner.js) -- there is no server-side processing at all, which is
// what keeps this app on Cloudflare's free Workers plan.
import { interpretUrl, ResolveError } from "./resolve.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

const MAX_RESOLVE_BODY_BYTES = 8 * 1024;
const MAX_FEEDBACK_BYTES = 8 * 1024;
const MAX_PROXY_BYTES = 80 * 1024 * 1024; // a full-country WMS mosaic tile plus headroom
const PROXY_TIMEOUT_MS = 60_000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function validProtocol(service, protocol) {
  return (
    (service === "wcs" && protocol === "1.0.0") ||
    (service === "wms" && ["1.1.1", "1.3.0"].includes(protocol))
  );
}

function sameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  // Sec-Fetch-Site is sent by every modern browser (unlike Origin, which
  // simple same-origin GETs may omit) and cannot be spoofed by page JS --
  // it is the real defense against another site's JS driving our proxy.
  const site = request.headers.get("Sec-Fetch-Site");
  return !site || site === "same-origin" || site === "none";
}

// Best-effort notification email via Resend (https://resend.com) -- a
// transactional email API chosen specifically because it needs no domain of
// our own: RESEND_API_KEY (a Worker secret) can send from the shared
// onboarding@resend.dev address to the account's own verified inbox with no
// DNS setup. Both RESEND_API_KEY and NOTIFY_EMAIL are optional: if either is
// unset this silently does nothing, so feedback still saves to D1 either
// way -- the email is a convenience, never a requirement for the feature.
export async function notifyFeedback(env, { message, service, protocol }) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: "AOI Raster Fetcher <onboarding@resend.dev>",
        to: [env.NOTIFY_EMAIL],
        subject: `New feedback — ${service.toUpperCase()} ${protocol}`,
        text: message,
      }),
    });
    if (!response.ok) {
      console.error("feedback email notification failed", response.status, await response.text());
    }
  } catch (error) {
    console.error("feedback email notification failed", error);
  }
}

async function saveFeedback(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "Invalid origin" }, 403);
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "JSON body required" }, 415);
  }
  if (Number(request.headers.get("content-length") || 0) > MAX_FEEDBACK_BYTES) {
    return json({ error: "Feedback report is too large" }, 413);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const service = typeof payload.service === "string" ? payload.service : "";
  const protocol = typeof payload.protocol === "string" ? payload.protocol : "";
  if (!message || message.length > 4000 || !validProtocol(service, protocol)) {
    return json({ error: "Invalid feedback report" }, 400);
  }

  try {
    await env.FEEDBACK_DB.prepare(
      "INSERT INTO feedback (message, service, protocol) VALUES (?, ?, ?)"
    )
      .bind(message, service, protocol)
      .run();
  } catch (error) {
    console.error("feedback insert failed", error);
    return json({ error: "Feedback could not be saved" }, 503);
  }
  // The D1 row above is what actually matters and is already saved; the
  // notification email is a convenience, so it runs after the response is
  // sent (waitUntil) instead of making the reporter wait on it, and never
  // turns a successful save into an error if it fails.
  ctx.waitUntil(notifyFeedback(env, { message, service, protocol }));
  return json({ ok: true }, 201);
}

async function resolveService(request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "Invalid origin" }, 403);
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "JSON body required" }, 415);
  }
  if (Number(request.headers.get("content-length") || 0) > MAX_RESOLVE_BODY_BYTES) {
    return json({ error: "Request body is too large" }, 413);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const url = typeof payload.url === "string" ? payload.url : "";
  if (!url) return json({ error: "A url is required." }, 400);

  try {
    const resolved = await interpretUrl(url, fetch);
    return json(resolved);
  } catch (error) {
    if (error instanceof ResolveError) return json({ error: error.message }, error.status);
    console.error("resolve failed", error);
    return json({ error: "Unexpected error resolving this URL." }, 500);
  }
}

function blockedProxyHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localdomain")) {
    return true;
  }
  // Literal private/loopback/link-local IPv4 addresses, as a string-level
  // defense in depth -- Cloudflare's own edge network already cannot route a
  // Worker's fetch() to these ranges, but this costs nothing to also check.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      return true;
    }
  }
  return false;
}

async function proxyRequest(request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "Invalid origin" }, 403);

  const target = new URL(request.url).searchParams.get("url");
  if (!target) return json({ error: "A url query parameter is required." }, 400);

  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch {
    return json({ error: "Invalid target URL." }, 400);
  }
  if (!["http:", "https:"].includes(parsedTarget.protocol)) {
    return json({ error: "Only http(s) URLs can be proxied." }, 422);
  }
  if (blockedProxyHost(parsedTarget.hostname)) {
    return json({ error: "Local/private service URLs are not allowed." }, 422);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(parsedTarget.toString(), {
      headers: { "User-Agent": "wms-wcs-aoi-fetcher/2.0" },
      signal: controller.signal,
    });
  } catch (error) {
    return json({ error: `Could not reach the source server: ${error.message}` }, 502);
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) {
    return json({ error: `The source server returned HTTP ${upstream.status}.` }, 502);
  }
  const contentLength = Number(upstream.headers.get("content-length") || 0);
  if (contentLength > MAX_PROXY_BYTES) {
    return json({ error: "The source server's response is too large to proxy." }, 413);
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  return new Response(upstream.body, {
    status: 200,
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/feedback") return saveFeedback(request, env, ctx);
    if (url.pathname === "/api/resolve") return resolveService(request);
    if (url.pathname === "/api/proxy") return proxyRequest(request);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
