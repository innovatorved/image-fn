import { corsHeaders, jsonResponse } from "./lib/cors";
import { letterboxPng } from "./lib/letterbox";
import { parseTransformParams, pickMimeFormat, buildOutputFilename, type FitMode, type TransformParams } from "./lib/transform";
import { safeFetchRemote } from "./lib/ssrf";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = new URL("../public/", import.meta.url);
const MAX_SOURCE_BYTES = readPositiveIntEnv("MAX_SOURCE_BYTES", 25 * 1024 * 1024);
const MAX_IMAGE_PIXELS = readPositiveIntEnv("MAX_IMAGE_PIXELS", 256 * 1024 * 1024);
const MAX_OUTPUT_PIXELS = readPositiveIntEnv("MAX_OUTPUT_PIXELS", 40 * 1024 * 1024);
const MAX_CACHE_BYTES = readPositiveIntEnv("MAX_CACHE_BYTES", 128 * 1024 * 1024);
const SOURCE_FETCH_TIMEOUT_MS = readPositiveIntEnv("SOURCE_FETCH_TIMEOUT_MS", 10_000);
const CACHE_TTL_MS = readPositiveIntEnv("CACHE_TTL_SECONDS", 3600) * 1000;
const ENVIRONMENT = process.env.ENVIRONMENT ?? "development";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const ALLOWED_HOST_SUFFIXES = process.env.ALLOWED_HOST_SUFFIXES ?? "*";
const ENGINE = "bun-image";

type CacheEntry = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  expiresAt: number;
  byteLength: number;
};

const transformCache = new Map<string, CacheEntry>();
let transformCacheBytes = 0;

const envForCors = { CORS_ORIGIN, ENVIRONMENT };

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(envForCors) });
    }

    if (url.pathname === "/api/health") {
      return jsonResponse(
        {
          status: "healthy",
          runtime: "bun",
          engine: ENGINE,
          storage: "none",
          maxImagePixels: MAX_IMAGE_PIXELS,
          maxOutputPixels: MAX_OUTPUT_PIXELS,
          maxCacheBytes: MAX_CACHE_BYTES,
        },
        200,
        envForCors
      );
    }

    if (url.pathname === "/api/image" && (request.method === "GET" || request.method === "HEAD")) {
      const redirect = new URL(request.url);
      redirect.pathname = "/i";
      return Response.redirect(redirect.toString(), 308);
    }

    if (url.pathname === "/i" && (request.method === "GET" || request.method === "HEAD")) {
      return handleTransform(request, url);
    }

    if (request.method === "GET" || request.method === "HEAD") {
      return serveStatic(url.pathname, request.method);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders(envForCors) });
  },
});

console.log(`ImageFn Bun server listening on http://localhost:${PORT} (maxImagePixels=${MAX_IMAGE_PIXELS})`);

async function handleTransform(request: Request, url: URL): Promise<Response> {
  const parsed = parseTransformParams(url.searchParams);
  if ("error" in parsed) {
    return jsonResponse({ error: parsed.error }, parsed.status, envForCors);
  }

  const accept = request.headers.get("accept");
  const cacheKey = buildCacheKey(url, accept, parsed);
  const cached = transformCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const headers = new Headers(cached.headers);
    headers.set("X-Cache", "HIT");
    if (request.method === "HEAD") {
      return withCors(new Response(null, { status: cached.status, headers }));
    }
    return withCors(new Response(cached.body.slice(), { status: cached.status, headers }));
  }
  if (cached) transformCache.delete(cacheKey);

  try {
    const result = parsed.placeholder
      ? await createPlaceholder(parsed, accept)
      : await transformImage(parsed, accept);

    if (!result.ok) {
      return jsonResponse({ error: result.error }, result.status, envForCors);
    }

    const headers = new Headers(result.headers);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("X-Cache", "MISS");
    headers.set("X-Transform-Engine", ENGINE);
    if (parsed.fmt === "auto") headers.set("Vary", "Accept");
    if (!parsed.placeholder) {
      const outputMime = result.headers.get("Content-Type") || undefined;
      const filename = buildOutputFilename(
        parsed,
        outputMime?.startsWith("image/") ? (outputMime as "image/avif" | "image/webp" | "image/jpeg" | "image/png") : undefined
      );
      headers.set("Content-Disposition", `attachment; filename="${filename}"`);
    }

    setCacheEntry(cacheKey, {
      status: 200,
      headers: headersToObject(headers),
      body: result.body,
      expiresAt: Date.now() + CACHE_TTL_MS,
      byteLength: result.body.byteLength,
    });

    if (request.method === "HEAD") {
      return withCors(new Response(null, { status: 200, headers }));
    }
    return withCors(new Response(result.body.slice(), { status: 200, headers }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transform failed";
    return jsonResponse({ error: message }, 500, envForCors);
  }
}

async function transformImage(
  params: TransformParams,
  accept: string | null
): Promise<{ ok: true; body: Uint8Array; headers: Headers } | { ok: false; error: string; status: number }> {
  const input = await readSourceBytes(params);
  if (!input.ok) return input;

  if (params.fit === "pad" && params.w !== undefined && params.h !== undefined) {
    return transformWithPad(params, accept, input.body);
  }

  const outputMime = pickMimeFormat(params.fmt, accept);
  const image = new Bun.Image(input.body, { maxPixels: MAX_IMAGE_PIXELS, autoOrient: true });
  const geometry = await applyGeometry(image, params, input.body);
  if (!geometry.ok) return geometry;

  if (params.brightness !== undefined || params.saturation !== undefined) {
    image.modulate({ brightness: params.brightness, saturation: params.saturation });
  }

  return encodeImage(image, outputMime, params.q);
}

async function transformWithPad(
  params: TransformParams,
  accept: string | null,
  body: Uint8Array
): Promise<{ ok: true; body: Uint8Array; headers: Headers } | { ok: false; error: string; status: number }> {
  const targetW = params.w!;
  const targetH = params.h!;
  const pixelCheck = validateOutputPixels(targetW, targetH);
  if (!pixelCheck.ok) return pixelCheck;

  const image = new Bun.Image(body, { maxPixels: MAX_IMAGE_PIXELS, autoOrient: true });
  const geometry = await applyGeometry(image, { ...params, fit: "inside" }, body);
  if (!geometry.ok) return geometry;
  const fittedPng = new Uint8Array(await image.png().bytes());
  const letterboxed = letterboxPng(fittedPng, targetW, targetH);

  let output = new Bun.Image(letterboxed, { maxPixels: MAX_IMAGE_PIXELS, autoOrient: false });
  if (params.brightness !== undefined || params.saturation !== undefined) {
    output = output.modulate({ brightness: params.brightness, saturation: params.saturation });
  }

  const outputMime = pickMimeFormat(params.fmt, accept);
  return encodeImage(output, outputMime, params.q);
}

async function applyGeometry(
  image: Bun.Image,
  params: TransformParams,
  sourceBody: Uint8Array
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (params.w !== undefined || params.h !== undefined) {
    const resizeOptions = buildResizeOptions(params);
    if (params.w !== undefined && params.h !== undefined) {
      const pixelCheck = validateOutputPixels(params.w, params.h);
      if (!pixelCheck.ok) return pixelCheck;
      image.resize(params.w, params.h, resizeOptions);
    } else if (params.w !== undefined) {
      image.resize(params.w, undefined, resizeOptions);
    } else if (params.h !== undefined) {
      const metadata = await new Bun.Image(sourceBody, { maxPixels: MAX_IMAGE_PIXELS, autoOrient: true }).metadata();
      const width = Math.max(1, Math.round((metadata.width / metadata.height) * params.h));
      const pixelCheck = validateOutputPixels(width, params.h);
      if (!pixelCheck.ok) return pixelCheck;
      image.resize(width, params.h, resizeOptions);
    }
  }
  if (params.rot !== undefined) image.rotate(params.rot);
  if (params.flip) image.flip();
  if (params.flop) image.flop();
  return { ok: true };
}

function buildResizeOptions(params: TransformParams): Bun.Image.ResizeOptions {
  const fit: FitMode = params.fit === "pad" ? "inside" : params.fit;
  const options: Bun.Image.ResizeOptions = { fit };
  if (params.withoutEnlargement) options.withoutEnlargement = true;
  if (params.filter) options.filter = params.filter;
  return options;
}

async function encodeImage(
  image: Bun.Image,
  outputMime: "image/avif" | "image/webp" | "image/jpeg" | "image/png",
  quality: number
): Promise<{ ok: true; body: Uint8Array; headers: Headers }> {
  let blob: Blob;
  switch (outputMime) {
    case "image/png":
      blob = await image.png().blob();
      break;
    case "image/jpeg":
      blob = await image.jpeg({ quality, progressive: true }).blob();
      break;
    case "image/avif":
      blob = await image.avif({ quality }).blob();
      break;
    case "image/webp":
    default:
      blob = await image.webp({ quality }).blob();
      break;
  }

  return {
    ok: true,
    body: new Uint8Array(await blob.arrayBuffer()),
    headers: new Headers({ "Content-Type": blob.type || outputMime }),
  };
}

async function createPlaceholder(
  params: TransformParams,
  accept: string | null
): Promise<{ ok: true; body: Uint8Array; headers: Headers } | { ok: false; error: string; status: number }> {
  const input = await readSourceBytes(params);
  if (!input.ok) return input;
  const dataUrl = await new Bun.Image(input.body, { maxPixels: MAX_IMAGE_PIXELS, autoOrient: true }).placeholder();
  const body = new TextEncoder().encode(JSON.stringify({ placeholder: dataUrl }));
  return { ok: true, body, headers: new Headers({ "Content-Type": "application/json" }) };
}

async function readSourceBytes(
  params: TransformParams
): Promise<{ ok: true; body: Uint8Array } | { ok: false; error: string; status: number }> {
  const fetched = await safeFetchRemote(params.sourceUrl, ALLOWED_HOST_SUFFIXES, MAX_SOURCE_BYTES, SOURCE_FETCH_TIMEOUT_MS);
  if (!fetched.ok) return fetched;
  return readResponseBytes(fetched.response, MAX_SOURCE_BYTES);
}

async function readResponseBytes(
  response: Response,
  maxBytes: number
): Promise<{ ok: true; body: Uint8Array } | { ok: false; error: string; status: number }> {
  if (!response.body) {
    return { ok: true, body: new Uint8Array(await response.arrayBuffer()) };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, error: `Source image exceeds size limit (${maxBytes} bytes)`, status: 413 };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

function validateOutputPixels(width: number, height: number): { ok: true } | { ok: false; error: string; status: number } {
  if (width * height > MAX_OUTPUT_PIXELS) {
    return { ok: false, error: `Output image exceeds pixel limit (${MAX_OUTPUT_PIXELS})`, status: 413 };
  }
  return { ok: true };
}

async function serveStatic(pathname: string, method: string): Promise<Response> {
  const path =
    pathname === "/"
      ? "/index.html"
      : pathname === "/docs" || pathname === "/docs/"
        ? "/docs.html"
        : pathname;
  const normalized = path.replace(/^\/+/, "");
  if (normalized.includes("..")) {
    return new Response("Not Found", { status: 404, headers: corsHeaders(envForCors) });
  }

  const file = Bun.file(new URL(normalized, PUBLIC_DIR));
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404, headers: corsHeaders(envForCors) });
  }

  const headers = new Headers(corsHeaders(envForCors));
  headers.set("Content-Type", contentTypeFor(normalized));
  headers.set("Cache-Control", isUnversionedUiAsset(normalized) ? "no-store" : "public, max-age=3600");

  if (method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(file, { status: 200, headers });
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function isUnversionedUiAsset(path: string): boolean {
  return path === "index.html" || path === "docs.html" || path === "app.js" || path === "style.css";
}

function buildCacheKey(url: URL, accept: string | null, params: TransformParams): string {
  const sorted = new URL(url.toString());
  const entries = [...sorted.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  sorted.search = "";
  for (const [key, value] of entries) sorted.searchParams.append(key, value);
  if (params.fmt === "auto" && accept) sorted.searchParams.set("__accept", accept);
  return sorted.toString();
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(envForCors))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function setCacheEntry(key: string, entry: CacheEntry): void {
  if (entry.byteLength > MAX_CACHE_BYTES) return;
  const existing = transformCache.get(key);
  if (existing) transformCacheBytes -= existing.byteLength;
  transformCache.set(key, entry);
  transformCacheBytes += entry.byteLength;
  pruneCache();
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of transformCache) {
    if (entry.expiresAt <= now) {
      transformCache.delete(key);
      transformCacheBytes -= entry.byteLength;
    }
  }
  while (transformCacheBytes > MAX_CACHE_BYTES) {
    const oldestKey = transformCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = transformCache.get(oldestKey);
    transformCache.delete(oldestKey);
    if (oldest) transformCacheBytes -= oldest.byteLength;
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
