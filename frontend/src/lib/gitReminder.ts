import type { GitStatus } from "../api";

export interface AutoPushPreset {
  secs: number;
  label: string;
}

export const DEFAULT_AUTO_PUSH_MESSAGE = "Auto-save: {files}";
export const DEFAULT_REMINDER_AFTER_MS = 15 * 60 * 1000;

export const AUTO_PUSH_PRESETS: readonly AutoPushPreset[] = [
  { secs: 0, label: "Aus" },
  { secs: 60, label: "Alle 1 Minute" },
  { secs: 300, label: "Alle 5 Minuten" },
  { secs: 600, label: "Alle 10 Minuten" },
  { secs: 900, label: "Alle 15 Minuten" },
  { secs: 1800, label: "Alle 30 Minuten" },
  { secs: 3600, label: "Alle 60 Minuten" },
];

export function formatAutoPushInterval(secs: number): string {
  if (secs <= 0) return "Aus";
  const preset = AUTO_PUSH_PRESETS.find((p) => p.secs === secs);
  if (preset) return preset.label;
  if (secs % 3600 === 0) {
    const h = secs / 3600;
    return h === 1 ? "Alle 1 Stunde" : `Alle ${h} Stunden`;
  }
  if (secs % 60 === 0) {
    return `Alle ${secs / 60} Minuten`;
  }
  return `Alle ${secs} Sekunden`;
}

export function hasPendingGitWork(status: GitStatus | null): boolean {
  if (!status) return false;
  return status.files.length > 0 || status.ahead > 0;
}

export function shouldRemindCommit(
  dirtySinceMs: number | null,
  nowMs: number,
  snoozedUntilMs: number | null,
  autoPushIntervalSecs: number,
  reminderAfterMs = DEFAULT_REMINDER_AFTER_MS
): boolean {
  if (autoPushIntervalSecs > 0) return false;
  if (dirtySinceMs === null) return false;
  if (snoozedUntilMs !== null && nowMs < snoozedUntilMs) return false;
  return nowMs - dirtySinceMs >= reminderAfterMs;
}

export function reminderSummary(status: GitStatus | null): string {
  if (!status) return "";
  const parts: string[] = [];
  if (status.files.length > 0) {
    parts.push(
      status.files.length === 1
        ? "1 ungespeicherte Git-Änderung"
        : `${status.files.length} ungespeicherte Git-Änderungen`
    );
  }
  if (status.ahead > 0) {
    parts.push(status.ahead === 1 ? "1 lokaler Commit nicht gepusht" : `${status.ahead} lokale Commits nicht gepusht`);
  }
  return parts.join(", ");
}

export function formatAutoPushTimestamp(iso: string | null): string {
  if (!iso) return "noch nie";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
