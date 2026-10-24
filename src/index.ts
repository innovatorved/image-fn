import { corsHeaders, jsonResponse } from "./lib/cors";
import { letterboxPng } from "./lib/letterbox";
import { parseTransformParams, pickMimeFormat, buildOutputFilename, type FitMode, type TransformParams } from "./lib/transform";
import { safeFetchRemote } from "./lib/ssrf";
import {
  CACHE_CONTAINER_NAME,
  RAW_CONTAINER_NAME,
  STORAGE_ACCOUNT_NAME,
  USING_CONNECTION_STRING,
  getCachedVariant,
  getRawBlob,
  initStorageContainers,
  isAzureStorageEnabled,
  isStorageReady,
  putCachedVariant,
  sanitizeBlobName,
  uploadRawBlob,
} from "./storage";

const PORT = Number(process.env.PORT ?? 8787);
const REGION = process.env.AZURE_REGION ?? "local";
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

// Native Bun.Image guard for the Azure-facing transform API.
const API_MAX_DIMENSION = 4096;
const API_MAX_PIXELS = API_MAX_DIMENSION * API_MAX_DIMENSION;
const API_FITS = new Set(["inside", "cover", "contain", "fill", "pad"]);
const API_FORMATS: Record<string, "image/webp" | "image/jpeg" | "image/png"> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
};
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/avif": "avif",
};

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

// Connect to Azure Blob Storage before accepting traffic (best-effort: the
// server still boots in stateless local-only mode when unconfigured).
await initStorageContainers();

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(envForCors) });
    }

    // Health probe for the regional Azure Standard Load Balancer + Azure Front Door.
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return jsonResponse(
        {
          status: "ok",
          service: "innovatorved/image-fn",
          region: REGION,
          bun: Bun.version,
          bunVersion: Bun.version,
          storageConfigured: isAzureStorageEnabled(),
          storageReady: isStorageReady(),
          storageAuth: USING_CONNECTION_STRING ? "connection-string" : "managed-identity",
          storageAccount: STORAGE_ACCOUNT_NAME || (isAzureStorageEnabled() ? "connection-string" : "none"),
          storage: isAzureStorageEnabled() ? "azure-blob" : "none",
          containers: { raw: RAW_CONTAINER_NAME, cache: CACHE_CONTAINER_NAME },
          timestamp: new Date().toISOString(),
          // Legacy fields kept for existing clients.
          healthy: true,
          runtime: "bun",
          engine: ENGINE,
          maxImagePixels: MAX_IMAGE_PIXELS,
          maxOutputPixels: MAX_OUTPUT_PIXELS,
          maxCacheBytes: MAX_CACHE_BYTES,
        },
        200,
        envForCors
      );
    }

    // Upload a raw original image to the `raw-images` container.
    if (url.pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request);
    }

    // Transform endpoint used by Azure Front Door + the regional load balancers.
    if (
      (url.pathname === "/api/transform" || url.pathname === "/transform") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return handleApiTransform(request, url);
    }

    if (url.pathname === "/api/image" && (request.method === "GET" || request.method === "HEAD")) {
      const redirect = new URL(request.url);
      redirect.pathname = "/i";
      return Response.redirect(redirect.toString(), 308);
    }

    if (url.pathname === "/i" && (request.method === "GET" || request.method === "HEAD")) {
      return handleTransform(request, url);
    }

    if (url.pathname === "/api" || url.pathname === "/api/info") {
      return jsonResponse(
        {
          service: "innovatorved/image-fn",
          region: REGION,
          engine: ENGINE,
          storageConfigured: isAzureStorageEnabled(),
          endpoints: {
            health: "GET /health",
            upload: "POST /api/upload (multipart/form-data field 'file')",
            transformExternalUrl: "GET /api/transform?url=https://...&w=800&h=600&fit=cover&format=webp&q=80",
            transformStoredBlob: "GET /api/transform?blob=<blobName>&w=800&format=webp&q=80",
            legacyTransform: "GET /i?url=https://...&w=800&fit=inside&fmt=webp&q=80",
          },
        },
        200,
        envForCors
      );
    }

    if (request.method === "GET" || request.method === "HEAD") {
      return serveStatic(url.pathname, request.method);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders(envForCors) });
  },
});

console.log(
  `[image-fn] Listening on http://0.0.0.0:${PORT} in region '${REGION}' ` +
    `(storage=${isAzureStorageEnabled() ? "azure-blob" : "none"}, maxImagePixels=${MAX_IMAGE_PIXELS})`
);

// ---------------------------------------------------------------------------
// Upload handler (POST /api/upload)
// ---------------------------------------------------------------------------
async function handleUpload(request: Request): Promise<Response> {
  if (!isAzureStorageEnabled()) {
    return jsonResponse(
      { error: "Azure Storage is not configured. Set AZURE_STORAGE_ACCOUNT_NAME or AZURE_STORAGE_CONNECTION_STRING." },
      503,
      envForCors
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return jsonResponse({ error: "Multipart field 'file' is required." }, 400, envForCors);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      return jsonResponse({ error: `Upload exceeds size limit (${MAX_SOURCE_BYTES} bytes)` }, 413, envForCors);
    }

    // Verify the payload is a decodable image before persisting it.
    const metadata = await new Bun.Image(bytes).metadata();

    const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "upload";
    const blobName = sanitizeBlobName(`${Date.now()}-${sanitizedName}`);

    await uploadRawBlob(blobName, bytes, file.type || `image/${metadata.format}`);

    return jsonResponse(
      {
        message: "Uploaded to Azure Blob Storage",
        blob: blobName,
        region: REGION,
        metadata,
        sampleTransformUrl: `/api/transform?blob=${encodeURIComponent(blobName)}&w=800&format=webp&q=80`,
      },
      200,
      envForCors
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return jsonResponse({ error: message }, 500, envForCors);
  }
}

// ---------------------------------------------------------------------------
// Azure-facing transform handler (GET/HEAD /api/transform)
// ---------------------------------------------------------------------------
async function handleApiTransform(request: Request, url: URL): Promise<Response> {
  const sourceUrl = url.searchParams.get("url")?.trim();
  const rawBlobName = url.searchParams.get("blob")?.trim();
  if (!sourceUrl && !rawBlobName) {
    return jsonResponse(
      { error: "Pass either '?url=https://...' or '?blob=<filename>' query parameter." },
      400,
      envForCors
    );
  }
  if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) {
    return jsonResponse({ error: "Transform source must be an HTTPS image URL" }, 400, envForCors);
  }

  const width = parseApiDimension(url.searchParams.get("w"));
  const height = parseApiDimension(url.searchParams.get("h"));
  const fit = (url.searchParams.get("fit")?.toLowerCase() || "inside") as FitMode;
  if (!API_FITS.has(fit)) {
    return jsonResponse({ error: "Invalid fit: use 'inside', 'cover', 'contain', 'fill', or 'pad'" }, 400, envForCors);
  }
  const formatRaw = (url.searchParams.get("format")?.toLowerCase() || "webp");
  const format = formatRaw === "jpg" ? "jpeg" : formatRaw;
  const contentType = API_FORMATS[format];
  if (!contentType) {
    return jsonResponse({ error: `Unsupported format: ${formatRaw}. Use webp, jpeg, or png.` }, 400, envForCors);
  }
  const quality = Math.min(Math.max(Number(url.searchParams.get("q")) || 80, 1), 100);

  const blobName = rawBlobName ? sanitizeBlobName(rawBlobName) : undefined;
  if (rawBlobName && !blobName) {
    return jsonResponse({ error: "Invalid 'blob' name." }, 400, envForCors);
  }
  const sourceIdentifier = blobName ? `blob:${blobName}` : `url:${sourceUrl}`;

  // Deterministic SHA-256 cache key from (source + width + height + fit + format + quality).
  const cacheKey = computeApiCacheKey(sourceIdentifier, width, height, fit, format, quality);

  // Step 1: Azure Blob Storage cache (shared across all 3 regions).
  const cached = await getCachedVariant(cacheKey);
  if (cached) {
    return imageResponse(request, cached.buffer, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Cache": cached.source,
      "X-Region": REGION,
      "X-Transform-Engine": ENGINE,
    });
  }

  // Step 2: Load source bytes from `raw-images` or an external URL (via the
  // regional NAT Gateway - outbound fetch goes through the VM's egress).
  let inputBytes: Uint8Array;
  if (blobName) {
    const raw = await getRawBlob(blobName);
    if (!raw) {
      return jsonResponse({ error: `Blob '${blobName}' not found in storage.` }, 404, envForCors);
    }
    if (raw.byteLength > MAX_SOURCE_BYTES) {
      return jsonResponse({ error: `Source image exceeds size limit (${MAX_SOURCE_BYTES} bytes)` }, 413, envForCors);
    }
    inputBytes = new Uint8Array(raw);
  } else {
    const fetched = await safeFetchRemote(sourceUrl!, ALLOWED_HOST_SUFFIXES, MAX_SOURCE_BYTES, SOURCE_FETCH_TIMEOUT_MS);
    if (!fetched.ok) {
      return jsonResponse({ error: fetched.error }, fetched.status, envForCors);
    }
    const read = await readResponseBytes(fetched.response, MAX_SOURCE_BYTES);
    if (!read.ok) {
      return jsonResponse({ error: read.error }, read.status, envForCors);
    }
    inputBytes = read.body;
  }

  // Step 3: Bun.Image native C/SIMD transformation pipeline.
  const transformed = await transformApiImage(inputBytes, { width, height, fit, format, quality, contentType });
  if (!transformed.ok) {
    return jsonResponse({ error: transformed.error }, transformed.status, envForCors);
  }

  // Step 4: Write-through to Azure Blob Storage (non-blocking).
  void putCachedVariant(cacheKey, transformed.body, contentType);

  return imageResponse(request, transformed.body, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Cache": "MISS-TRANSFORMED",
    "X-Region": REGION,
    "X-Transform-Engine": ENGINE,
  });
}

async function transformApiImage(
  inputBytes: Uint8Array,
  options: {
    width?: number;
    height?: number;
    fit: FitMode;
    format: string;
    quality: number;
    contentType: "image/webp" | "image/jpeg" | "image/png";
  }
): Promise<{ ok: true; body: Uint8Array } | { ok: false; error: string; status: number }> {
  const { width, height, fit, quality, contentType } = options;

  // `pad` needs both dimensions: resize inside then letterbox onto a white canvas.
  if (fit === "pad" && width !== undefined && height !== undefined) {
    const pixelCheck = validateOutputPixels(width, height);
    if (!pixelCheck.ok) return pixelCheck;
    try {
      const inner = new Bun.Image(inputBytes, { maxPixels: API_MAX_PIXELS, autoOrient: true });
      inner.resize(width, height, { fit: "inside", withoutEnlargement: true });
      const fittedPng = new Uint8Array(await inner.png().bytes());
      const letterboxed = letterboxPng(fittedPng, width, height);
      const output = new Bun.Image(letterboxed, { maxPixels: API_MAX_PIXELS, autoOrient: false });
      const encoded = await encodeImage(output, contentType, quality);
      return { ok: true, body: encoded.body };
    } catch (error) {
      return { ok: false, error: `Image processing error: ${errorMessage(error)}`, status: 422 };
    }
  }

  try {
    const image = new Bun.Image(inputBytes, { maxPixels: API_MAX_PIXELS, autoOrient: true });
    // Bun.Image only supports `inside` and `fill`; `cover`/`contain` map to `inside`.
    const bunFit = fit === "fill" ? "fill" : "inside";
    const resizeOptions: Bun.Image.ResizeOptions = { fit: bunFit, withoutEnlargement: true };

    if (width !== undefined && height !== undefined) {
      const pixelCheck = validateOutputPixels(width, height);
      if (!pixelCheck.ok) return pixelCheck;
      image.resize(width, height, resizeOptions);
    } else if (width !== undefined) {
      image.resize(width, undefined, resizeOptions);
    } else if (height !== undefined) {
      const metadata = await new Bun.Image(inputBytes, { maxPixels: API_MAX_PIXELS, autoOrient: true }).metadata();
      const derivedWidth = Math.max(1, Math.round((metadata.width / metadata.height) * height));
      const pixelCheck = validateOutputPixels(derivedWidth, height);
      if (!pixelCheck.ok) return pixelCheck;
      image.resize(derivedWidth, height, resizeOptions);
    }

    const encoded = await encodeImage(image, contentType, quality);
    return { ok: true, body: encoded.body };
  } catch (error) {
    return { ok: false, error: `Image processing error: ${errorMessage(error)}`, status: 422 };
  }
}

function computeApiCacheKey(
  sourceIdentifier: string,
  width?: number,
  height?: number,
  fit?: string,
  format?: string,
  quality?: number
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    `${sourceIdentifier}|w=${width ?? 0}|h=${height ?? 0}|fit=${fit ?? "inside"}|fmt=${format ?? "webp"}|q=${quality ?? 80}`
  );
  return `${hasher.digest("hex")}.${format ?? "webp"}`;
}

function parseApiDimension(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(value, API_MAX_DIMENSION);
}

function imageResponse(
  request: Request,
  body: Uint8Array | ArrayBuffer,
  headersInit: Record<string, string>
): Response {
  const headers = new Headers(headersInit);
  for (const [key, value] of Object.entries(corsHeaders(envForCors))) {
    headers.set(key, value);
  }
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(bodyInit(body), { status: 200, headers });
}

/**
 * `Buffer`/`Uint8Array` are valid runtime bodies but TypeScript's DOM
 * `BodyInit` (TS 5.9+) is typed against `Uint8Array<ArrayBuffer>` specifically,
 * so the shared Azure-cache buffers need an explicit widening.
 */
function bodyInit(body: Uint8Array | ArrayBuffer): BodyInit {
  return body as unknown as BodyInit;
}

// ---------------------------------------------------------------------------
// Legacy transform handler (GET/HEAD /i) - now backed by the shared Azure cache
// ---------------------------------------------------------------------------
async function handleTransform(request: Request, url: URL): Promise<Response> {
  const parsed = parseTransformParams(url.searchParams);
  if ("error" in parsed) {
    return jsonResponse({ error: parsed.error }, parsed.status, envForCors);
  }

  const accept = request.headers.get("accept");
  const outputMime = pickMimeFormat(parsed.fmt, accept);
  const cacheKey = buildCacheKey(url, accept, parsed);
  const azureCacheKey = buildAzureVariantKey(parsed, outputMime, accept);
  const canUseAzure = isAzureStorageEnabled() && !parsed.placeholder;

  // L1: per-instance in-memory cache.
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

  // L2: shared Azure Blob cache (cross-region, survives restarts).
  if (canUseAzure) {
    const azureCached = await getCachedVariant(azureCacheKey);
    if (azureCached) {
      const headers = buildTransformHeaders(parsed, outputMime);
      headers.set("X-Cache", azureCached.source);
      headers.set("X-Region", REGION);
      if (request.method === "HEAD") {
        return withCors(new Response(null, { status: 200, headers }));
      }
      return withCors(new Response(bodyInit(azureCached.buffer), { status: 200, headers }));
    }
  }

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
      const outputMimeHeader = result.headers.get("Content-Type") || undefined;
      const filename = buildOutputFilename(
        parsed,
        outputMimeHeader?.startsWith("image/")
          ? (outputMimeHeader as "image/avif" | "image/webp" | "image/jpeg" | "image/png")
          : undefined
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

    // Write-through to Azure so sibling regions can serve this variant.
    if (canUseAzure) {
      void putCachedVariant(azureCacheKey, result.body, outputMime);
    }

    if (request.method === "HEAD") {
      return withCors(new Response(null, { status: 200, headers }));
    }
    return withCors(new Response(result.body.slice(), { status: 200, headers }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transform failed";
    return jsonResponse({ error: message }, 500, envForCors);
  }
}

function buildTransformHeaders(
  params: TransformParams,
  outputMime: "image/avif" | "image/webp" | "image/jpeg" | "image/png"
): Headers {
  const headers = new Headers({ "Content-Type": outputMime });
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Transform-Engine", ENGINE);
  if (params.fmt === "auto") headers.set("Vary", "Accept");
  if (!params.placeholder) {
    const filename = buildOutputFilename(params, outputMime);
    headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  }
  return headers;
}

function buildAzureVariantKey(
  params: TransformParams,
  outputMime: "image/avif" | "image/webp" | "image/jpeg" | "image/png",
  accept: string | null
): string {
  const descriptor = [
    `src=${params.sourceUrl}`,
    `w=${params.w ?? 0}`,
    `h=${params.h ?? 0}`,
    `fit=${params.fit}`,
    `fmt=${outputMime}`,
    `q=${params.q}`,
    `rot=${params.rot ?? 0}`,
    `flip=${params.flip ? 1 : 0}`,
    `flop=${params.flop ? 1 : 0}`,
    `blur=${params.blur ?? 0}`,
    `brightness=${params.brightness ?? 1}`,
    `saturation=${params.saturation ?? 1}`,
    `withoutEnlargement=${params.withoutEnlargement ? 1 : 0}`,
    `filter=${params.filter ?? "lanczos3"}`,
    params.fmt === "auto" ? `accept=${accept ?? ""}` : "",
  ].join("|");

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(descriptor);
  return `${hasher.digest("hex")}.${EXTENSION_BY_MIME[outputMime] ?? "bin"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Transform failed";
}

// ---------------------------------------------------------------------------
// Existing Bun.Image transform helpers (unchanged)
// ---------------------------------------------------------------------------
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
