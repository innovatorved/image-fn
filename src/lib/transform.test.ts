import { parseTransformParams, pickMimeFormat, buildOutputFilename } from "./transform";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const base = parseTransformParams(new URLSearchParams("url=https://example.com/a.jpg&w=100&h=100"));
assert(!("error" in base), "valid params");
if (!("error" in base)) {
  assert(base.w === 100, "width parsed");
  assert(base.h === 100, "height parsed");
  assert(base.fit === "pad", "fit defaults to pad");
}

const inside = parseTransformParams(new URLSearchParams("url=https://example.com/a.jpg&w=100&h=100&fit=inside"));
assert(!("error" in inside), "inside fit accepted");
if (!("error" in inside)) {
  assert(inside.fit === "inside", "inside fit parsed");
}

const padMissing = parseTransformParams(new URLSearchParams("url=https://example.com/a.jpg&w=100&fit=pad"));
assert("error" in padMissing, "pad requires both dimensions");

const modulated = parseTransformParams(
  new URLSearchParams("url=https://example.com/a.jpg&w=100&h=100&fit=inside&brightness=2&saturation=0")
);
assert(!("error" in modulated), "accepts Bun.Image modulation");
if (!("error" in modulated)) {
  assert(modulated.brightness === 2, "brightness parsed");
  assert(modulated.saturation === 0, "saturation parsed");
}

const nonHttpsUrl = parseTransformParams(new URLSearchParams("url=blob:https://example.com/local-demo"));
assert("error" in nonHttpsUrl, "rejects non-HTTPS source URLs");

assert(pickMimeFormat("auto", "image/avif,image/webp") === "image/avif", "accept avif");

const filename = buildOutputFilename({
  sourceUrl: "https://cdn.example.com/photos/sunset.jpg",
  w: 400,
  h: 400,
  fit: "pad",
  rot: 90,
  flip: false,
  flop: false,
  fmt: "webp",
  q: 80,
  placeholder: false,
  withoutEnlargement: false,
});
assert(filename === "sunset-w400-h400-contain-rot90.webp", "download filename uses source name and transform suffix");

console.log("transform.test.ts: ok");
