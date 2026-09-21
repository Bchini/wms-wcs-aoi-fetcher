import { Container, getContainer } from "@cloudflare/containers";

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

const MAX_PROCESS_BODY_BYTES = 8 * 1024;
const MAX_FEEDBACK_BYTES = 8 * 1024;
// Must stay in sync with containers[].max_instances in wrangler.jsonc: routing
// to a bounded pool reuses warm containers instead of booting a new one per
// request, and never asks for more instances than the account allows.
const CONTAINER_POOL_SIZE = 2;

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
    ).bind(message, service, protocol).run();
  } catch (error) {
    console.error("feedback insert failed", error);
    return json({ error: "Feedback could not be saved" }, 503);
  }
  return json({ ok: true }, 201);
}

async function processRaster(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "Invalid origin" }, 403);
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "JSON body required" }, 415);
  }
  if (Number(request.headers.get("content-length") || 0) > MAX_PROCESS_BODY_BYTES) {
    return json({ error: "Request body is too large" }, 413);
  }

  const slot = Math.floor(Math.random() * CONTAINER_POOL_SIZE);
  try {
    const processor = getContainer(env.GDAL_PROCESSOR, `gdal-${slot}`);
    return await processor.fetch(request);
  } catch (error) {
    // Without this the client receives an HTML runtime error and the UI, which
    // parses JSON, reports a meaningless failure.
    console.error("container request failed", error);
    return json({ error: "The processing container is unavailable. Try again shortly." }, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/feedback") return saveFeedback(request, env);
    if (url.pathname === "/api/process") return processRaster(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
