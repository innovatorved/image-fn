export function corsHeaders(env: { CORS_ORIGIN?: string; ENVIRONMENT?: string }): Record<string, string> {
  const isDev = env.ENVIRONMENT === "development";
  const origin = isDev ? "*" : env.CORS_ORIGIN ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonResponse(
  data: unknown,
  status: number,
  env: { CORS_ORIGIN?: string; ENVIRONMENT?: string },
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
      ...extraHeaders,
    },
  });
}
