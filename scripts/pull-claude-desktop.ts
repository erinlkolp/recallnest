#!/usr/bin/env bun
/**
 * pull-claude-desktop.ts
 *
 * Pulls Claude Desktop / web conversation history from claude.ai and
 * converts it into CC transcript .jsonl format for `lm ingest --source desktop` to consume.
 *
 * Usage:
 *   CLAUDE_SESSION_KEY="sk-ant-..." bun scripts/pull-claude-desktop.ts
 *   CLAUDE_SESSION_KEY="sk-ant-..." bun scripts/pull-claude-desktop.ts --limit 10
 *   CLAUDE_SESSION_KEY="sk-ant-..." bun scripts/pull-claude-desktop.ts --since 2025-01-01
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// ============================================================================
// Config
// ============================================================================

const BASE_URL = "https://claude.ai";
const PAGE_SIZE = 50;
const THROTTLE_MS = 200;
const MAX_RETRIES = 3;
const OUTPUT_DIR = join(import.meta.dir, "..", "data", "desktop-import");
const SYNC_STATE_PATH = join(OUTPUT_DIR, ".sync-state.json");

// ============================================================================
// Types
// ============================================================================

interface SyncState {
  lastSyncedAt: string;
  conversations: Record<
    string,
    {
      messageCount: number;
      updatedAt: string;
      pulledAt: string;
      name: string;
    }
  >;
}

interface ConversationSummary {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface ChatMessage {
  uuid: string;
  text: string;
  sender: "human" | "assistant";
  index: number;
  created_at: string;
  parent_message_uuid: string;
  content: Array<{
    type: "text" | "thinking" | "tool_use" | "tool_result";
    text?: string;
    name?: string;
    input?: unknown;
  }>;
  attachments?: Array<{
    file_name: string;
    file_type?: string;
    file_size?: number;
  }>;
}

interface Conversation {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: ChatMessage[];
}

// ============================================================================
// HTTP Client
// ============================================================================

class ClaudeApiClient {
  private sessionKey: string;
  private orgId: string | null = null;
  private throttleMs = THROTTLE_MS;

  constructor(sessionKey: string) {
    this.sessionKey = sessionKey;
  }

  private async request(path: string): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${BASE_URL}${path}`, {
          headers: {
            Cookie: `sessionKey=${this.sessionKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        });

        if (res.status === 401 || res.status === 403) {
          throw new Error(
            `Authentication failed (${res.status}). The sessionKey may have expired; please fetch a new one from your browser.`,
          );
        }

        if (res.status === 429) {
          this.throttleMs = Math.min(this.throttleMs * 2, 5000);
          console.log(`  ⚠️  Rate limited; waiting ${this.throttleMs}ms...`);
          await sleep(this.throttleMs);
          continue;
        }

        if (res.status >= 500) {
          const waitMs = Math.pow(2, attempt) * 1000;
          console.log(
            `  ⚠️  Server error ${res.status}; retrying in ${waitMs}ms...`,
          );
          await sleep(waitMs);
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }

        // Reset throttle on success
        this.throttleMs = THROTTLE_MS;
        return await res.json();
      } catch (err: any) {
        if (
          err.message?.includes("Authentication failed") ||
          err.message?.startsWith("HTTP ")
        ) {
          throw err;
        }
        lastError = err;
        const waitMs = Math.pow(2, attempt) * 1000;
        console.log(`  ⚠️  Network error: ${err.message}; retrying in ${waitMs}ms...`);
        await sleep(waitMs);
      }
    }

    throw lastError || new Error("Request failed after 3 retries");
  }

  async getOrgId(): Promise<string> {
    if (this.orgId) return this.orgId;
    const orgs = await this.request("/api/organizations");
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error("Failed to fetch organization. Please confirm the sessionKey is valid.");
    }
    this.orgId = orgs[0].uuid;
    return this.orgId!;
  }

  async listConversations(
    offset: number = 0,
  ): Promise<ConversationSummary[]> {
    const orgId = await this.getOrgId();
    return await this.request(
      `/api/organizations/${orgId}/chat_conversations?limit=${PAGE_SIZE}&offset=${offset}`,
    );
  }

  async getConversation(chatId: string): Promise<Conversation> {
    const orgId = await this.getOrgId();
    return await this.request(
      `/api/organizations/${orgId}/chat_conversations/${chatId}?tree=True&rendering_mode=messages&render_all_tools=true`,
    );
  }

  async throttle(): Promise<void> {
    await sleep(this.throttleMs);
  }
}

// ============================================================================
// Branch Extraction
// ============================================================================

function extractLatestBranch(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return [];

  const byUuid = new Map<string, ChatMessage>();
  for (const msg of messages) {
    byUuid.set(msg.uuid, msg);
  }

  // Find all parent UUIDs
  const parentUuids = new Set<string>();
  for (const msg of messages) {
    if (msg.parent_message_uuid) {
      parentUuids.add(msg.parent_message_uuid);
    }
  }

  // Leaves = messages that are not anyone's parent
  const leaves = messages.filter((m) => !parentUuids.has(m.uuid));
  if (leaves.length === 0) return messages;

  // Pick the leaf with the latest timestamp
  const latestLeaf = leaves.reduce((a, b) =>
    new Date(a.created_at).getTime() >= new Date(b.created_at).getTime()
      ? a
      : b,
  );

  // Walk backwards from leaf to root
  const branch: ChatMessage[] = [];
  let current: ChatMessage | undefined = latestLeaf;
  const visited = new Set<string>();

  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    branch.push(current);
    current = current.parent_message_uuid
      ? byUuid.get(current.parent_message_uuid)
      : undefined;
  }

  branch.reverse();
  return branch;
}

// ============================================================================
// Format Conversion
// ============================================================================

function messageToText(msg: ChatMessage): string {
  const parts: string[] = [];

  if (Array.isArray(msg.content) && msg.content.length > 0) {
    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      }
      // Skip thinking, tool_use, tool_result — noise for memory
    }
  } else if (msg.text) {
    // Fallback: use raw text field
    parts.push(msg.text);
  }

  // Mark attachments
  if (Array.isArray(msg.attachments)) {
    for (const att of msg.attachments) {
      parts.push(`[Attachment: ${att.file_name}]`);
    }
  }

  return parts.join("\n").trim();
}

function convertToCCTranscript(
  conversation: Conversation,
): string[] {
  const branch = extractLatestBranch(conversation.chat_messages || []);
  const lines: string[] = [];

  for (const msg of branch) {
    const text = messageToText(msg);
    if (!text || text.length < 5) continue;

    const type = msg.sender === "human" ? "user" : "assistant";
    const entry = {
      type,
      message: {
        role: type,
        content: text,
      },
      sessionId: conversation.uuid,
      timestamp: msg.created_at,
      uuid: msg.uuid,
      parentUuid: msg.parent_message_uuid || undefined,
    };

    lines.push(JSON.stringify(entry));
  }

  return lines;
}

// ============================================================================
// Sync State
// ============================================================================

function loadSyncState(): SyncState {
  if (existsSync(SYNC_STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(SYNC_STATE_PATH, "utf-8"));
    } catch {
      // Corrupted, start fresh
    }
  }
  return { lastSyncedAt: "", conversations: {} };
}

function saveSyncState(state: SyncState): void {
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

function needsPull(
  state: SyncState,
  conv: ConversationSummary,
): boolean {
  const existing = state.conversations[conv.uuid];
  if (!existing) return true;
  // Re-pull if conversation was updated since last pull
  return conv.updated_at !== existing.updatedAt;
}

// ============================================================================
// Main
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "session-key": { type: "string" },
      limit: { type: "string" },
      since: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    strict: false,
  });

  const sessionKey =
    values["session-key"] ||
    process.env.CLAUDE_SESSION_KEY ||
    process.env.CLAUDE_DESKTOP_SESSION_KEY;

  if (!sessionKey) {
    console.error(
      "❌ A sessionKey is required. Usage:\n" +
        "   CLAUDE_SESSION_KEY='...' bun scripts/pull-claude-desktop.ts\n\n" +
        "How to get it: log in to claude.ai in your browser → DevTools → Application → Cookies → sessionKey",
    );
    process.exit(1);
  }

  const limit = values.limit ? parseInt(values.limit, 10) : Infinity;
  const sinceDate = values.since ? new Date(values.since) : null;
  const verbose = values.verbose ?? false;

  // Ensure output directory
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const client = new ClaudeApiClient(sessionKey);
  const state = loadSyncState();

  // Step 1: Verify auth
  console.log("🔑 Verifying sessionKey...");
  try {
    const orgId = await client.getOrgId();
    console.log(`  ✅ Authenticated (org: ${orgId.slice(0, 8)}...)`);
  } catch (err: any) {
    console.error(`  ❌ ${err.message}`);
    process.exit(1);
  }

  // Step 2: List all conversations (paginated)
  console.log("\n📋 Fetching conversation list...");
  const allConversations: ConversationSummary[] = [];
  let offset = 0;
  let pageCount = 0;

  while (true) {
    const page = await client.listConversations(offset);
    if (!Array.isArray(page) || page.length === 0) break;

    // Filter by --since if specified
    for (const conv of page) {
      if (sinceDate && new Date(conv.updated_at) < sinceDate) {
        // API returns newest first; once we hit older, stop
        console.log(
          `  ⏭️  Skipping conversations before ${conv.updated_at} (--since ${values.since})`,
        );
        break;
      }
      allConversations.push(conv);
    }

    pageCount++;
    process.stdout.write(
      `  Scanned ${allConversations.length} conversations (page ${pageCount})...\r`,
    );

    // Stop if we hit the since boundary or got a short page
    if (sinceDate) {
      const lastOnPage = page[page.length - 1];
      if (new Date(lastOnPage.updated_at) < sinceDate) break;
    }
    if (page.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
    await client.throttle();
  }

  console.log(`  ✅ Found ${allConversations.length} conversations total`);

  // Step 3: Filter — skip already-synced
  const toPull = allConversations.filter((c) => needsPull(state, c));
  const toSkip = allConversations.length - toPull.length;

  if (toSkip > 0) {
    console.log(`  ⏭️  ${toSkip} already synced; skipping`);
  }

  // Apply --limit
  const batch = toPull.slice(0, limit);
  if (batch.length === 0) {
    console.log("\n✅ No new conversations to pull.");
    return;
  }

  console.log(`\n🔄 Pulling ${batch.length} conversations...\n`);

  // Step 4: Pull each conversation
  let pulled = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < batch.length; i++) {
    const conv = batch[i];
    const label = conv.name?.slice(0, 40) || conv.uuid.slice(0, 8);

    try {
      process.stdout.write(
        `  [${i + 1}/${batch.length}] ${label}...`,
      );

      const full = await client.getConversation(conv.uuid);
      const lines = convertToCCTranscript(full);

      if (lines.length === 0) {
        console.log(` ⏭️  Empty conversation`);
        skipped++;
      } else {
        const outPath = join(OUTPUT_DIR, `${conv.uuid}.jsonl`);
        writeFileSync(outPath, lines.join("\n") + "\n");
        console.log(` ✅ ${lines.length} messages`);
        pulled++;
      }

      // Update sync state
      state.conversations[conv.uuid] = {
        messageCount: lines.length,
        updatedAt: conv.updated_at,
        pulledAt: new Date().toISOString(),
        name: conv.name || "",
      };

      // Save state periodically (every 10 conversations)
      if ((i + 1) % 10 === 0) {
        state.lastSyncedAt = new Date().toISOString();
        saveSyncState(state);
      }

      await client.throttle();
    } catch (err: any) {
      console.log(` ❌ ${err.message}`);
      errors.push(`${label}: ${err.message}`);
      failed++;

      // Don't abort on single conversation failure
      await client.throttle();
    }
  }

  // Final save
  state.lastSyncedAt = new Date().toISOString();
  saveSyncState(state);

  // Step 5: Summary
  console.log("\n📊 Pull summary:");
  console.log(`  Total conversations: ${allConversations.length}`);
  console.log(`  Skipped (already synced): ${toSkip}`);
  console.log(`  Pulled this run: ${pulled}`);
  console.log(`  Skipped (empty): ${skipped}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Output directory: ${OUTPUT_DIR}`);

  if (errors.length > 0) {
    console.log("\n⚠️  Failure details:");
    for (const e of errors.slice(0, 10)) {
      console.log(`  - ${e}`);
    }
  }

  if (pulled > 0) {
    console.log(
      "\n🎯 Next step: run the following command to import the conversations into RecallNest:",
    );
    console.log("   bun run src/cli.ts ingest --source desktop");
  }
}

main().catch((err) => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
