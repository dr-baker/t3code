import { THREAD_WATCH_OVERSIGHT_DEFAULTS, type ThreadWatchOversight } from "@t3tools/contracts";

export interface QuietWatchCheckIn {
  readonly note: string | null;
}

const QUIET_ACK_PREFIX = THREAD_WATCH_OVERSIGHT_DEFAULTS.quietAckToken.toLowerCase();

/**
 * Matches a parent thread's quiet oversight ack (`[watch:ok]` plus optional 1-line note).
 * Only matches when the token leads the response so normal user-facing messages never collapse.
 */
export function parseQuietWatchCheckIn(text: string): QuietWatchCheckIn | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(QUIET_ACK_PREFIX)) return null;
  const remainder = trimmed.slice(QUIET_ACK_PREFIX.length);
  if (remainder.length > 0 && !/[\s:.,—–-]/.test(remainder[0]!)) return null;
  const cleaned = remainder.replace(/^[\s:.,—–-]+/, "").trim();
  if (cleaned.length === 0) return { note: null };
  const firstLine = cleaned.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return { note: firstLine.length > 0 ? firstLine : null };
}

export function formatQuietWatchCheckInLabel(input: {
  readonly note: string | null;
  readonly summary?: string | null;
}): string {
  const detail = input.note ?? input.summary?.trim() ?? null;
  if (!detail) return "Checked in · on track";
  const compact = detail.length > 88 ? `${detail.slice(0, 87).trimEnd()}…` : detail;
  return `Checked in · ${compact}`;
}

export function formatWatchOversightCadence(oversight: ThreadWatchOversight): string {
  const minutes = Math.round(oversight.everySeconds / 60);
  const timeLabel =
    oversight.everySeconds % 60 === 0 && minutes >= 1
      ? `${minutes}m`
      : `${oversight.everySeconds}s`;
  return `Oversight · ${oversight.everyItems} items / ${timeLabel}`;
}
