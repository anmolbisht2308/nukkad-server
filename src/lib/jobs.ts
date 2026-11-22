import { Business } from "../models/index.js";
import { notify } from "./notify.js";

/* Background jobs, run in-process every few minutes.
   Opening alerts: "opens tomorrow" reminder, then "open now" on the day (and flip status). */
async function openingAlerts() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3_600_000);

  const remind = await Business.find({ "opening.status": "coming_soon", "opening.reminded": false, "opening.date": { $lte: tomorrow, $gt: now } }).select("+opening.notifyList");
  for (const b of remind) {
    await notify(b.opening?.notifyList ?? [], { type: "opening_day", emoji: b.emoji, title: `${b.name} opens tomorrow`, body: `${b.area} · be one of the first through the door`, link: `/b/${b.slug}` });
    b.set("opening.reminded", true);
    await b.save();
  }

  const open = await Business.find({ "opening.status": "coming_soon", "opening.date": { $lte: now } }).select("+opening.notifyList");
  for (const b of open) {
    await notify(b.opening?.notifyList ?? [], { type: "opening_day", emoji: "🎉", title: `${b.name} is open now!`, body: "Opening-day deals are live", link: `/b/${b.slug}` });
    b.set("opening.status", "open");
    b.set("opening.announced", true);
    await b.save();
  }
}

export function startJobs() {
  const run = () => openingAlerts().catch((e) => console.error("[jobs] openingAlerts", e));
  run();
  return setInterval(run, 5 * 60_000);
}
