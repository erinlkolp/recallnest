import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cleanupPaths: string[] = [];

afterAll(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function writeTempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "recallnest-mcp-e2e-"));
  cleanupPaths.push(dir);
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    dbPath: join(dir, "db"),
    embedding: {
      provider: "openai-compatible",
      apiKey: "test-key-unused",
      model: "test-embedding-model",
      dimensions: 8,
    },
    sources: {},
  }, null, 2));
  return configPath;
}

describe("mcp-server end-to-end over stdio", () => {
  it("distill_session runs without throwing a ReferenceError", async () => {
    const configPath = writeTempConfig();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [resolve(import.meta.dir, "../mcp-server.ts")],
      env: {
        ...process.env as Record<string, string>,
        LOCAL_MEMORY_CONFIG: configPath,
      },
    });
    const client = new Client({ name: "e2e-test", version: "0.0.1" });

    try {
      await client.connect(transport);

      const result = await client.callTool({
        name: "distill_session",
        arguments: {
          messages: [{ role: "user", content: "hello world" }],
          scope: "project:e2e-test",
          persist: false,
        },
      }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

      const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
      expect(text).not.toContain("llmClient is not defined");
      expect(result.isError ?? false).toBe(false);
      expect(text).toContain("Microcompact:");
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);
});
