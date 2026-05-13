import { describe, expect, it } from "bun:test";

import { parseAllowedHostsEnv, validateLocalRequest } from "../server-csrf.js";

const PORT = 4318;

function makeRequest(headers: Record<string, string>, init: { method?: string } = {}): Request {
  return new Request("http://127.0.0.1:4318/v1/store", {
    method: init.method ?? "POST",
    headers,
  });
}

describe("validateLocalRequest", () => {
  it("accepts a loopback Host with matching Origin and application/json body", () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "127.0.0.1:4318",
        origin: "http://127.0.0.1:4318",
        "content-type": "application/json",
      }),
      { port: PORT },
    );
    expect(result).toBeNull();
  });

  it("accepts localhost Host and Origin", () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "localhost:4318",
        origin: "http://localhost:4318",
        "content-type": "application/json",
      }),
      { port: PORT },
    );
    expect(result).toBeNull();
  });

  it("rejects requests whose Host header is not a loopback target (DNS rebinding)", async () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "evil.example:4318",
        "content-type": "application/json",
      }),
      { port: PORT },
    );
    expect(result).not.toBeNull();
    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { reason?: string };
    expect(body.reason).toBe("host");
  });

  it("rejects requests with a foreign Origin (browser CSRF)", async () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "127.0.0.1:4318",
        origin: "https://evil.example",
        "content-type": "application/json",
      }),
      { port: PORT },
    );
    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { reason?: string };
    expect(body.reason).toBe("origin");
  });

  it("allows a missing Origin header (curl, server-to-server clients)", () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "127.0.0.1:4318",
        "content-type": "application/json",
      }),
      { port: PORT },
    );
    expect(result).toBeNull();
  });

  it("rejects POST requests with Content-Type text/plain (CORS simple-request bypass)", async () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "127.0.0.1:4318",
        "content-type": "text/plain",
      }),
      { port: PORT },
    );
    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { reason?: string };
    expect(body.reason).toBe("content_type");
  });

  it("rejects POST requests with no Content-Type", () => {
    const result = validateLocalRequest(
      makeRequest({ host: "127.0.0.1:4318" }),
      { port: PORT },
    );
    expect(result?.status).toBe(403);
  });

  it("allows GET requests without Content-Type", () => {
    const result = validateLocalRequest(
      makeRequest({ host: "127.0.0.1:4318" }, { method: "GET" }),
      { port: PORT },
    );
    expect(result).toBeNull();
  });

  it("accepts application/json with charset parameter", () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "127.0.0.1:4318",
        "content-type": "application/json; charset=utf-8",
      }),
      { port: PORT },
    );
    expect(result).toBeNull();
  });

  it("rejects literal 'null' Origin (sandboxed iframes, opaque origins)", async () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "127.0.0.1:4318",
        origin: "null",
        "content-type": "application/json",
      }),
      { port: PORT },
    );
    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { reason?: string };
    expect(body.reason).toBe("origin");
  });

  it("honors extraAllowedHosts for non-loopback binds", () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "my-lan-host:4318",
        origin: "http://my-lan-host:4318",
        "content-type": "application/json",
      }),
      { port: PORT, extraAllowedHosts: ["my-lan-host"] },
    );
    expect(result).toBeNull();
  });

  it("still rejects an unrelated Host even when extraAllowedHosts is configured", async () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "evil.example:4318",
        "content-type": "application/json",
      }),
      { port: PORT, extraAllowedHosts: ["my-lan-host"] },
    );
    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { reason?: string };
    expect(body.reason).toBe("host");
  });

  it("rejects matching host on the wrong port", async () => {
    const result = validateLocalRequest(
      makeRequest({
        host: "127.0.0.1:9999",
        "content-type": "application/json",
      }),
      { port: PORT },
    );
    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { reason?: string };
    expect(body.reason).toBe("host");
  });

  it("treats the IPv6 loopback variants as allowed", () => {
    for (const host of ["::1:4318", "[::1]:4318"]) {
      const result = validateLocalRequest(
        makeRequest({ host, "content-type": "application/json" }),
        { port: PORT },
      );
      expect(result).toBeNull();
    }
  });

  it("validates Host even on GET (DNS rebinding read-path defense)", async () => {
    const result = validateLocalRequest(
      makeRequest({ host: "evil.example:4318" }, { method: "GET" }),
      { port: PORT },
    );
    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { reason?: string };
    expect(body.reason).toBe("host");
  });
});

describe("parseAllowedHostsEnv", () => {
  it("returns an empty list when the env var is unset", () => {
    expect(parseAllowedHostsEnv(undefined)).toEqual([]);
    expect(parseAllowedHostsEnv("")).toEqual([]);
  });

  it("splits comma-separated hostnames and trims whitespace", () => {
    expect(parseAllowedHostsEnv("foo, bar ,baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("drops empty entries", () => {
    expect(parseAllowedHostsEnv("foo,,bar")).toEqual(["foo", "bar"]);
  });
});
