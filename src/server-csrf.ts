/**
 * Shared CSRF / DNS-rebinding hardening for RecallNest's local HTTP servers.
 *
 * Both `ui-server.ts` and `api-server.ts` bind to a loopback interface and
 * trust their environment, but a webpage opened in the user's browser is in
 * the same trust zone. Without these checks, any visited page can issue
 * cross-origin "simple" requests (text/plain body) to localhost and trigger
 * memory-store mutations. DNS-rebinding can also turn read endpoints into a
 * data exfil channel.
 *
 * `validateLocalRequest` returns a 403 `Response` when the inbound request
 * fails any check, or `null` to let the handler proceed.
 */

const DEFAULT_LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"] as const;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface CsrfValidationOptions {
  port: number;
  extraAllowedHosts?: readonly string[];
}

export interface CsrfValidationFailure {
  status: 403;
  reason: "host" | "origin" | "content_type";
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function buildAllowedHostHeaders(hosts: readonly string[], port: number): Set<string> {
  const headers = new Set<string>();
  for (const raw of hosts) {
    const host = normalizeHost(raw);
    if (!host) continue;
    headers.add(`${host}:${port}`);
    if (port === 80 || port === 443) {
      headers.add(host);
    }
  }
  return headers;
}

function buildAllowedOrigins(hosts: readonly string[], port: number): Set<string> {
  const origins = new Set<string>();
  for (const raw of hosts) {
    const host = normalizeHost(raw);
    if (!host) continue;
    origins.add(`http://${host}:${port}`);
    origins.add(`https://${host}:${port}`);
    if (port === 80) origins.add(`http://${host}`);
    if (port === 443) origins.add(`https://${host}`);
  }
  return origins;
}

function forbidden(reason: CsrfValidationFailure["reason"], detail: string): Response {
  return Response.json({ error: `Forbidden: ${detail}`, reason }, { status: 403 });
}

export function validateLocalRequest(
  request: Request,
  options: CsrfValidationOptions,
): Response | null {
  const allowedHosts = [...DEFAULT_LOOPBACK_HOSTS, ...(options.extraAllowedHosts ?? [])];

  const hostHeader = request.headers.get("host");
  const allowedHostHeaders = buildAllowedHostHeaders(allowedHosts, options.port);
  if (!hostHeader || !allowedHostHeaders.has(normalizeHost(hostHeader))) {
    return forbidden("host", "invalid Host header");
  }

  const origin = request.headers.get("origin");
  if (origin !== null) {
    const allowedOrigins = buildAllowedOrigins(allowedHosts, options.port);
    if (!allowedOrigins.has(normalizeHost(origin))) {
      return forbidden("origin", "cross-origin request rejected");
    }
  }

  if (MUTATING_METHODS.has(request.method.toUpperCase())) {
    const contentType = request.headers.get("content-type") ?? "";
    const baseType = contentType.split(";")[0].trim().toLowerCase();
    if (baseType !== "application/json") {
      return forbidden("content_type", "Content-Type must be application/json");
    }
  }

  return null;
}

export function parseAllowedHostsEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
