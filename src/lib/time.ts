/* Time windows in India Standard Time (UTC+5:30), whatever the server's timezone. */
const IST = 330 * 60_000;

const istParts = (d: Date) => {
  const t = new Date(d.getTime() + IST);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay(), h: t.getUTCHours() };
};
/** A wall-clock time in IST → real Date. */
const istDate = (y: number, m: number, d: number, h = 0, min = 0) => new Date(Date.UTC(y, m, d, h, min) - IST);

export type When = "today" | "tonight" | "weekend" | "week";

export function window(when: When, now = new Date()): { from: Date; to: Date } {
  const p = istParts(now);
  const endOfDay = istDate(p.y, p.m, p.d, 23, 59);
  switch (when) {
    case "today":
      return { from: now, to: endOfDay };
    case "tonight": {
      const six = istDate(p.y, p.m, p.d, 18);
      return { from: now > six ? now : six, to: istDate(p.y, p.m, p.d + 1, 3) };
    }
    case "weekend": {
      // Saturday 00:00 → Sunday 23:59; if it's already the weekend, start now
      const toSat = (6 - p.dow + 7) % 7;
      const isWeekend = p.dow === 6 || p.dow === 0;
      const satStart = istDate(p.y, p.m, p.d + (isWeekend ? (p.dow === 0 ? -1 : 0) : toSat));
      const sunEnd = new Date(satStart.getTime() + 2 * 86_400_000 - 60_000);
      return { from: isWeekend ? now : satStart, to: sunEnd };
    }
    case "week":
    default:
      return { from: now, to: new Date(now.getTime() + 7 * 86_400_000) };
  }
}

export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
