export type FitMode = "inside" | "fill" | "pad";
export type OutputFormat = "webp" | "jpeg" | "png" | "avif" | "auto";
export type ResizeFilter =
  | "nearest"
  | "box"
  | "bilinear"
  | "linear"
  | "cubic"
  | "mitchell"
  | "lanczos2"
  | "lanczos3"
  | "mks2013"
  | "mks2021";

export interface TransformParams {
  sourceUrl: string;
  w?: number;
  h?: number;
  fit: FitMode;
  rot?: 90 | 180 | 270;
  flip: boolean;
  flop: boolean;
  fmt: OutputFormat;
  q: number;
  placeholder: boolean;
  blur?: number;
  brightness?: number;
  saturation?: number;
  withoutEnlargement: boolean;
  filter?: ResizeFilter;
}

export interface TransformError {
  error: string;
  status: number;
}

const MAX_DIMENSION = 12000;
const ALLOWED_ROTATIONS = new Set([90, 180, 270]);
const ALLOWED_FILTERS = new Set<ResizeFilter>([
  "nearest",
  "box",
  "bilinear",
  "linear",
  "cubic",
  "mitchell",
  "lanczos2",
  "lanczos3",
  "mks2013",
  "mks2021",
]);

export function pickMimeFormat(
  fmt: OutputFormat,
  acceptHeader: string | null
): "image/avif" | "image/webp" | "image/jpeg" | "image/png" {
  if (fmt === "auto") {
    const accept = acceptHeader ?? "";
    if (/image\/avif/i.test(accept)) return "image/avif";
    if (/image\/webp/i.test(accept)) return "image/webp";
    return "image/jpeg";
  }
  switch (fmt) {
    case "avif":
      return "image/avif";
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpeg":
    default:
      return "image/jpeg";
  }
}

export function parseTransformParams(searchParams: URLSearchParams): TransformParams | TransformError {
  const sourceUrl = searchParams.get("url")?.trim();
  if (!sourceUrl) {
    return { error: "Missing 'url' query parameter", status: 400 };
  }
  if (!/^https:\/\//i.test(sourceUrl)) {
    return { error: "Transform source must be an HTTPS image URL", status: 400 };
  }

  const wStr = searchParams.get("w");
  const hStr = searchParams.get("h");
  let w: number | undefined;
  let h: number | undefined;

  if (wStr !== null && wStr !== "") {
    w = parseInt(wStr, 10);
    if (Number.isNaN(w) || w < 1 || w > MAX_DIMENSION) {
      return { error: `Invalid width: must be 1–${MAX_DIMENSION}`, status: 400 };
    }
  }
  if (hStr !== null && hStr !== "") {
    h = parseInt(hStr, 10);
    if (Number.isNaN(h) || h < 1 || h > MAX_DIMENSION) {
      return { error: `Invalid height: must be 1–${MAX_DIMENSION}`, status: 400 };
    }
  }

  const fitRaw = (searchParams.get("fit") || "pad") as FitMode;
  if (fitRaw !== "inside" && fitRaw !== "fill" && fitRaw !== "pad") {
    return { error: "Invalid fit: use 'inside', 'fill', or 'pad'", status: 400 };
  }
  if (fitRaw === "pad" && (w === undefined || h === undefined)) {
    return { error: "fit=pad requires both 'w' and 'h'", status: 400 };
  }

  const rotStr = searchParams.get("rot");
  let rot: 90 | 180 | 270 | undefined;
  if (rotStr !== null && rotStr !== "") {
    const rotNum = parseInt(rotStr, 10);
    if (!ALLOWED_ROTATIONS.has(rotNum)) {
      return { error: "Invalid rotation: must be 90, 180, or 270", status: 400 };
    }
    rot = rotNum as 90 | 180 | 270;
  }

  const fmtRaw = (searchParams.get("fmt") || "webp").toLowerCase();
  const allowedFormats = ["webp", "jpeg", "jpg", "png", "avif", "auto"];
  if (!allowedFormats.includes(fmtRaw)) {
    return { error: `Unsupported format: ${fmtRaw}`, status: 400 };
  }
  const fmt: OutputFormat = fmtRaw === "jpg" ? "jpeg" : (fmtRaw as OutputFormat);

  const qStr = searchParams.get("q");
  let q = 80;
  if (qStr !== null && qStr !== "") {
    q = parseInt(qStr, 10);
    if (Number.isNaN(q) || q < 1 || q > 100) {
      return { error: "Invalid quality: must be 1–100", status: 400 };
    }
  }

  const placeholder = searchParams.get("placeholder") === "true";
  const blurStr = searchParams.get("blur");
  let blur: number | undefined;
  if (blurStr !== null && blurStr !== "") {
    blur = parseInt(blurStr, 10);
    if (Number.isNaN(blur) || blur < 1 || blur > 250) {
      return { error: "Invalid blur: must be 1–250", status: 400 };
    }
  }

  const brightness = parseModulateParam(searchParams.get("brightness"), "brightness");
  if ("error" in brightness) return brightness;
  const saturation = parseModulateParam(searchParams.get("saturation"), "saturation");
  if ("error" in saturation) return saturation;

  const filterRaw = searchParams.get("filter");
  let filter: ResizeFilter | undefined;
  if (filterRaw !== null && filterRaw !== "") {
    if (!ALLOWED_FILTERS.has(filterRaw as ResizeFilter)) {
      return { error: "Invalid filter: see Bun.Image resize filter list", status: 400 };
    }
    filter = filterRaw as ResizeFilter;
  }

  return {
    sourceUrl,
    w,
    h,
    fit: fitRaw,
    rot,
    flip: searchParams.get("flip") === "true",
    flop: searchParams.get("flop") === "true",
    fmt,
    q,
    placeholder,
    blur: placeholder ? 20 : blur,
    brightness: brightness.value,
    saturation: saturation.value,
    withoutEnlargement: searchParams.get("withoutEnlargement") === "true",
    filter,
  };
}

function parseModulateParam(
  raw: string | null,
  name: "brightness" | "saturation"
): { value?: number } | TransformError {
  if (raw === null || raw === "") return {};
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 3) {
    return { error: `Invalid ${name}: must be 0–3`, status: 400 };
  }
  return { value };
}

export function buildCacheKey(url: URL): string {
  const sorted = new URL(url.toString());
  const entries = [...sorted.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  sorted.search = "";
  for (const [k, v] of entries) {
    sorted.searchParams.append(k, v);
  }
  return sorted.toString();
}

export function buildOutputFilename(
  params: TransformParams,
  outputMime?: "image/avif" | "image/webp" | "image/jpeg" | "image/png"
): string {
  const base = extractBaseName(params.sourceUrl);
  const tags: string[] = [];

  if (params.w !== undefined && params.h !== undefined) tags.push(`w${params.w}-h${params.h}`);
  else if (params.w !== undefined) tags.push(`w${params.w}`);
  else if (params.h !== undefined) tags.push(`h${params.h}`);

  if (params.w !== undefined || params.h !== undefined) {
    tags.push(fitLabel(params.fit));
  }
  if (params.rot !== undefined) tags.push(`rot${params.rot}`);
  if (params.flip) tags.push("flip");
  if (params.flop) tags.push("flop");
  if (params.withoutEnlargement) tags.push("no-upscale");
  if (params.fmt !== "png" && params.q !== 80) tags.push(`q${params.q}`);
  if (params.brightness !== undefined) tags.push(`b${formatModulationTag(params.brightness)}`);
  if (params.saturation !== undefined) tags.push(`s${formatModulationTag(params.saturation)}`);

  const ext = outputExtension(params.fmt, outputMime);
  const suffix = tags.length > 0 ? `-${tags.join("-")}` : "";
  return `${base}${suffix}.${ext}`;
}

function extractBaseName(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    const segment = decodeURIComponent(url.pathname).split("/").filter(Boolean).pop();
    const raw = segment && segment.length > 0 ? segment : url.hostname.replace(/^www\./, "");
    const stem = raw.replace(/\.[^.]+$/, "");
    return sanitizeFilename(stem) || "image";
  } catch {
    return "image";
  }
}

function sanitizeFilename(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);
}

function fitLabel(fit: FitMode): string {
  if (fit === "pad") return "contain";
  if (fit === "fill") return "cover";
  return "inside";
}

function formatModulationTag(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function outputExtension(
  fmt: OutputFormat,
  outputMime?: "image/avif" | "image/webp" | "image/jpeg" | "image/png"
): string {
  if (fmt === "jpeg") return "jpg";
  if (fmt === "auto" && outputMime) {
    if (outputMime === "image/jpeg") return "jpg";
    if (outputMime === "image/png") return "png";
    if (outputMime === "image/avif") return "avif";
    return "webp";
  }
  return fmt === "auto" ? "webp" : fmt;
}

