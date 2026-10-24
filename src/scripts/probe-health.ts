// src/scripts/probe-health.ts
//
// Curls the health endpoint (default `http://localhost:$PORT/health`) and exits
// non-zero when the service is unhealthy. Handy for a local smoke test or a
// container healthcheck.
//
//   bun run probe:health
//   HEALTH_URL=https://image-fn.example.com/health bun run probe:health

const port = process.env.PORT ?? "8787";
const url = process.env.HEALTH_URL ?? `http://localhost:${port}/health`;

try {
  const response = await fetch(url);
  const body = await response.json();
  console.log(response.status, JSON.stringify(body, null, 2));
  if (!response.ok) process.exit(1);
} catch (error) {
  console.error(`[probe:health] ${url} failed:`, error instanceof Error ? error.message : error);
  process.exit(1);
}

export {};
