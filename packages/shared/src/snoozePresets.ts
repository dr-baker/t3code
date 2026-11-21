// @effect-diagnostics globalDate:off -- Snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

interface SnoozePreset {
  readonly id: string;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setDate(next.getDate() + days);
  return next;
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "3 hours", "90 minutes", "2 days": the largest unit that divides evenly. */
function formatSnoozeDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return pluralize(minutes / (24 * 60), "day");
  if (minutes % 60 === 0) return pluralize(minutes / 60, "hour");
  return pluralize(minutes, "minute");
}

function capitalize(word: string): string {
  return word[0]!.toUpperCase() + word.slice(1);
}

function snoozePresetDaysAhead(
  setting: Extract<SnoozePresetSetting, { kind: "at" }>,
  now: Date,
): number {
  if (setting.day === "today") return 0;
  if (setting.day === "tomorrow") return 1;
  return (WEEKDAY_INDEX[setting.day] - now.getDay() + 7) % 7 || 7;
}

/** Labels follow the actual day gap, so a Monday option on a Sunday reads "Tomorrow". */
function snoozePresetLabel(setting: SnoozePresetSetting, daysAhead: number): string {
  if (setting.kind === "after") return `In ${formatSnoozeDuration(setting.minutes)}`;
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  }
  if (daysAhead === 1) return "Tomorrow";
  if (setting.day === "monday") return "Next week";
  return daysAhead === 7 ? `Next ${capitalize(setting.day)}` : capitalize(setting.day);
}

function snoozePresetId(setting: SnoozePresetSetting): string {
  return setting.kind === "after"
    ? `after:${setting.minutes}`
    : `at:${setting.day}:${setting.time}`;
}

function resolveSnoozePreset(
  setting: SnoozePresetSetting,
  now: Date,
  formatTime: (date: Date) => string = snoozeTimeOfDayLabel,
): SnoozePreset | null {
  let wake: Date;
  let daysAhead = 0;
  if (setting.kind === "after") {
    wake = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + setting.minutes * 60_000));
  } else {
    daysAhead = snoozePresetDaysAhead(setting, now);
    wake = addSnoozeDays(now, daysAhead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    // A today option whose time has passed is left out until tomorrow.
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = snoozePresetLabel(setting, daysAhead);
  // Durations and "Next week" don't name the wake day, so a wake on another day shows it.
  const labelNamesDay = setting.kind === "at" && label !== "Next week";
  const time = formatTime(wake);
  return {
    id: snoozePresetId(setting),
    label,
    whenLabel:
      labelNamesDay || wake.toDateString() === now.toDateString()
        ? time
        : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    snoozedUntil: wake.toISOString(),
  };
}

export function resolveAutoSnoozeUntil(
  presets: ReadonlyArray<SnoozePresetSetting>,
  selection: string,
  now: Date,
): string | undefined {
  if (selection === "settle") return undefined;
  const available = presets.flatMap((preset) => resolveSnoozePreset(preset, now) ?? []);
  const selected = available.find((preset) => preset.id === selection);
  return (
    (
      selected ??
      available.reduce<SnoozePreset | undefined>(
        (latest, preset) =>
          !latest || preset.snoozedUntil > latest.snoozedUntil ? preset : latest,
        undefined,
      )
    )?.snoozedUntil ?? new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString()
  );
}

export function autoSnoozeOptions(presets: ReadonlyArray<SnoozePresetSetting>) {
  const choices = new Map(
    presets.map((preset) => [
      snoozePresetId(preset),
      {
        value: snoozePresetId(preset),
        label:
          preset.kind === "after"
            ? `In ${formatSnoozeDuration(preset.minutes)}`
            : `${capitalize(preset.day)} at ${preset.time}`,
      },
    ]),
  );
  return [{ value: "longest", label: "Longest available" }, ...choices.values()];
}
