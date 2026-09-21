import { Container, getContainer } from "@cloudflare/containers";

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function validProtocol(service, protocol) {
  return (service === "wcs" && protocol === "1.0.0") ||
    (service === "wms" && ["1.1.1", "1.3.0"].includes(protocol)) ||
    (service === "wmts" && protocol === "1.0.0");
}

function sameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

export class GdalProcessor extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
}

async function saveFeedback(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!sameOrigin(request)) return json({ error: "Invalid origin" }, 403);
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "JSON body required" }, 415);
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

  await env.FEEDBACK_DB.prepare(
    "INSERT INTO feedback (message, service, protocol) VALUES (?, ?, ?)"
  ).bind(message, service, protocol).run();
  return json({ ok: true }, 201);
}

async function processRaster(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "Invalid origin" }, 403);
  if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
    return json({ error: "Multipart form data required" }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 20 * 1024 * 1024) {
    return json({ error: "AOI upload must not exceed 20 MB" }, 413);
  }

  const processor = getContainer(env.GDAL_PROCESSOR, crypto.randomUUID());
  return processor.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/feedback") return saveFeedback(request, env);
    if (url.pathname === "/api/process") return processRaster(request, env);
    return env.ASSETS.fetch(request);
  },
};
