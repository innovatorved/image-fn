import { lookup } from "node:dns/promises";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

function isPrivateIpv4(a: number, b: number, c: number): boolean {
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    return isPrivateIpv4(ipv4[0], ipv4[1], ipv4[2]);
  }

  if (host.includes(":")) {
    const lower = host.toLowerCase();
    if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) {
      return true;
    }
  }

  return false;
}

function isBlockedIpAddress(address: string): boolean {
  return isBlockedHost(address);
}

export function validateAllowedHostSuffixes(hostname: string, allowedSuffixes: string | undefined): boolean {
  if (!allowedSuffixes || allowedSuffixes.trim() === "" || allowedSuffixes.trim() === "*") {
    return true;
  }
  const host = hostname.toLowerCase();
  const suffixes = allowedSuffixes
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export async function assertSafeRemoteUrl(
  rawUrl: string,
  allowedHostSuffixes?: string
): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Only HTTPS remote URLs are allowed" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "URLs with credentials are not allowed" };
  }

  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: "URL host is not allowed" };
  }

  try {
    const records = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (records.some((record) => isBlockedIpAddress(record.address))) {
      return { ok: false, error: "URL resolves to a blocked network" };
    }
  } catch {
    return { ok: false, error: "Could not resolve URL host" };
  }

  if (!validateAllowedHostSuffixes(parsed.hostname, allowedHostSuffixes)) {
    return { ok: false, error: "URL host is not in the allowed list" };
  }

  return { ok: true, url: parsed };
}

export async function safeFetchRemote(
  rawUrl: string,
  allowedHostSuffixes: string | undefined,
  maxBytes: number,
  timeoutMs = 10_000
): Promise<{ ok: true; response: Response } | { ok: false; error: string; status: number }> {
  const check = await assertSafeRemoteUrl(rawUrl, allowedHostSuffixes);
  if (!check.ok) {
    return { ok: false, error: check.error, status: 400 };
  }

  let currentUrl = check.url.toString();
  let redirects = 0;

  while (redirects <= 3) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "ImageFn/1.0" },
      });
    } catch (error) {
      const message = error instanceof DOMException && error.name === "AbortError" ? "Source fetch timed out" : "Failed to fetch source image";
      return { ok: false, error: message, status: 504 };
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (!location) {
        return { ok: false, error: "Redirect without Location header", status: 400 };
      }
      redirects += 1;
      if (redirects > 3) {
        return { ok: false, error: "Too many redirects", status: 400 };
      }
      const nextCheck = await assertSafeRemoteUrl(new URL(location, currentUrl).toString(), allowedHostSuffixes);
      if (!nextCheck.ok) {
        return { ok: false, error: nextCheck.error, status: 400 };
      }
      currentUrl = nextCheck.url.toString();
      continue;
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `Failed to fetch source image: ${response.status} ${response.statusText}`,
        status: 400,
      };
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return { ok: false, error: `Source image exceeds size limit (${maxBytes} bytes)`, status: 413 };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.startsWith("image/")) {
      return { ok: false, error: "Source URL did not return an image", status: 400 };
    }

    return { ok: true, response };
  }

  return { ok: false, error: "Too many redirects", status: 400 };
}
