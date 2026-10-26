const ICON_BUTTON_WIDTH = 36;
const ICON_GAP = 4;

export function pinnedDrawerPreview<T>(threads: readonly T[], width: number) {
  const slots = Math.max(1, Math.floor((width + ICON_GAP) / (ICON_BUTTON_WIDTH + ICON_GAP)));
  const count = threads.length > slots ? slots - 1 : slots;
  return { visible: threads.slice(0, count), hiddenCount: Math.max(0, threads.length - count) };
}
