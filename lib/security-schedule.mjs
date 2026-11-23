const day = 24 * 60 * 60 * 1000;

export function dailySlot(cron, observedAt) {
  const time = new Date(observedAt);
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(cron?.trim() ?? "");
  if (!match || !Number.isFinite(time.getTime())) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  const slot = new Date(time).setUTCHours(hour, minute, 0, 0);
  return slot > time.getTime() ? slot - day : slot;
}

export function dailyWindow(slot) {
  return [new Date(slot).toISOString(), new Date(slot + day - 1).toISOString()];
}

export const elapsedSeconds = (from, to) => Math.floor((to - from) / 1000);

export function elapsedTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return [hours && `${hours}h`, minutes % 60 && `${minutes % 60}m`, `${seconds % 60}s`]
    .filter(Boolean).join(" ");
}
