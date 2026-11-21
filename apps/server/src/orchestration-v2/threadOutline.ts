import {
  THREAD_WATCH_OVERSIGHT_DEFAULTS,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

const COMMAND_FAILURE_TAIL_CHARS = 320;
const COMMAND_INPUT_MAX_CHARS = 180;
const DYNAMIC_TOOL_INPUT_MAX_CHARS = 160;
const INLINE_ITEM_MAX_CHARS = 600;

function jsonPreview(value: unknown, maxChars: number): string | null {
  if (value === undefined || value === null) return null;
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  const singleLine = serialized.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return null;
  return singleLine.length > maxChars
    ? `${singleLine.slice(0, maxChars - 1).trimEnd()}…`
    : singleLine;
}

function firstLineCompact(text: string, maxChars: number): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars - 1).trimEnd()}…`;
}

function tailCompact(text: string | undefined, maxChars: number): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= maxChars) return trimmed;
  return `…${trimmed.slice(trimmed.length - (maxChars - 1)).trimStart()}`;
}

export function isTurnItemSettled(item: OrchestrationV2TurnItem): boolean {
  if ((item.type === "assistant_message" || item.type === "reasoning") && item.streaming) {
    return false;
  }
  switch (item.status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return true;
    case "idle":
    case "pending":
    case "running":
    case "waiting":
      return false;
    default: {
      const _exhaustive: never = item.status;
      return _exhaustive;
    }
  }
}

/**
 * True when an assistant message is a mid-turn update (commentary / partial answer, or any
 * settled assistant message emitted while its run is still active).
 */
export function isOversightCommentaryItem(
  item: OrchestrationV2TurnItem,
  targetRunActive: boolean,
): boolean {
  if (item.type !== "assistant_message" || !isTurnItemSettled(item)) return false;
  if (item.text.trim().length === 0) return false;
  if (item.phase === "commentary" || item.phase === "partial_answer") return true;
  return targetRunActive && item.phase !== "final_answer";
}

export function isOversightCountedStep(item: OrchestrationV2TurnItem): boolean {
  if (!isTurnItemSettled(item)) return false;
  switch (item.type) {
    case "assistant_message":
    case "reasoning":
    case "proposed_plan":
    case "todo_list":
    case "file_change":
    case "command_execution":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
    case "error":
      return true;
    case "user_message":
    case "notification":
    case "user_input_request":
    case "approval_request":
    case "checkpoint":
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
    case "compaction":
    case "handoff":
    case "fork":
    case "thread_created":
    case "secret_request":
    case "link_request":
      return false;
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

/**
 * Structural outline of a turn item: keeps intent (messages, commentary, reasoning, plans,
 * questions, errors) verbatim while reducing bulky tool/diff payloads to headers.
 */
export function formatTurnItemOutline(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "reasoning":
      return item.text;
    case "assistant_message":
      return item.phase === "commentary" || item.phase === "partial_answer"
        ? `[${item.phase}] ${item.text}`
        : item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonPreview(item.questions, INLINE_ITEM_MAX_CHARS);
    case "file_change": {
      const stats =
        item.additions === undefined && item.deletions === undefined
          ? ""
          : ` (+${item.additions ?? 0} -${item.deletions ?? 0})`;
      const extraFiles =
        item.changes !== undefined && item.changes.length > 1
          ? ` [${item.changes.length} files]`
          : "";
      return `${item.fileName}${stats}${extraFiles}`;
    }
    case "command_execution": {
      const header = `$ ${firstLineCompact(item.input, COMMAND_INPUT_MAX_CHARS)} [${item.status}]`;
      if (item.status !== "failed") return header;
      const tail = tailCompact(item.output, COMMAND_FAILURE_TAIL_CHARS);
      return tail === null ? header : `${header}\n${tail}`;
    }
    case "file_search": {
      const count = item.results?.length;
      const countSuffix = count === undefined ? "" : ` (${count} results)`;
      return `search ${item.pattern}${countSuffix}`;
    }
    case "web_search": {
      const count = item.results?.length;
      const countSuffix = count === undefined ? "" : ` (${count} results)`;
      const queries = item.patterns?.join(", ") ?? "";
      return queries.length > 0
        ? `web_search ${queries}${countSuffix}`
        : `web_search${countSuffix}`;
    }
    case "approval_request":
      return [item.prompt ?? item.requestKind, item.reason]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "checkpoint":
      return `checkpoint (${item.files.length} files)`;
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "link_request":
      return item.linkStatus === "linked"
        ? `Linked ${item.linkedLabel ?? item.url ?? "an environment"} (${item.linkedAccess}).`
        : `Asked the user to link ${item.url ?? "an environment"}: ${item.linkStatus}.`;
    case "subagent": {
      const label = item.title ?? firstLineCompact(item.prompt, 120);
      return `subagent [${item.status}] ${label}`;
    }
    case "dynamic_tool": {
      const name = item.toolName ?? "tool";
      const preview = jsonPreview(item.input, DYNAMIC_TOOL_INPUT_MAX_CHARS);
      return preview === null
        ? `tool ${name} [${item.status}]`
        : `tool ${name} [${item.status}] ${preview}`;
    }
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

export function formatOversightOutlineDelta(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  options?: {
    readonly maxItems?: number;
    readonly maxChars?: number;
  },
): string {
  const maxItems = options?.maxItems ?? THREAD_WATCH_OVERSIGHT_DEFAULTS.inlineOutlineMaxItems;
  const maxChars = options?.maxChars ?? THREAD_WATCH_OVERSIGHT_DEFAULTS.inlineOutlineMaxChars;
  const recent = rows.slice(-maxItems);
  const omittedCount = Math.max(0, rows.length - recent.length);
  const lines: Array<string> = [];
  if (omittedCount > 0) {
    lines.push(`(${omittedCount} earlier item${omittedCount === 1 ? "" : "s"} omitted)`);
  }
  let usedChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
  for (const row of recent) {
    const raw = formatTurnItemOutline(row.item);
    if (raw === null || raw.trim().length === 0) continue;
    const clipped =
      raw.length > INLINE_ITEM_MAX_CHARS
        ? `${raw.slice(0, INLINE_ITEM_MAX_CHARS - 1).trimEnd()}…`
        : raw;
    const line = `- [${row.sourceItemId}] (${row.item.type}) ${clipped}`;
    if (usedChars + line.length + 1 > maxChars && lines.length > 0) {
      lines.push('(outline truncated; use t3_thread_read view="outline" for more)');
      break;
    }
    lines.push(line);
    usedChars += line.length + 1;
  }
  return lines.join("\n");
}
