import { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { body, HttpError, notFound, parseQuery } from "../lib/http.js";
import { notify } from "../lib/notify.js";
import { createOrder, verifyPayment } from "../lib/payments.js";
import { award, POINTS } from "../lib/points.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { Business, User } from "../models/index.js";
import { Booking, Court, OpenGame, SlotLock, SPORTS } from "../models/play.js";

/* Phase 2 — Play: venues, live slot availability, bookings with split payments, open games. */
const r = Router();

/* ---------------- shared booking helpers (also used by routes/venue.ts) ---------------- */
const IST = 330 * 60_000;

export const istToday = (offsetDays = 0) => {
  const t = new Date(Date.now() + IST + offsetDays * 86_400_000);
  return t.toISOString().slice(0, 10);
};

/** Real instant for an IST wall-clock hour on a YYYY-MM-DD date. */
export const slotStart = (date: string, hour: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour) - IST);
};

type CourtLike = { pricePerHour: number; peakPricePerHour: number; peakFrom: number; peakTo: number };
export const isPeak = (c: CourtLike, hour: number) => hour >= c.peakFrom && hour < c.peakTo;
export const priceFor = (c: CourtLike, hour: number) => (isPeak(c, hour) ? c.peakPricePerHour : c.pricePerHour);
export const priceForRange = (c: CourtLike, start: number, hours: number) =>
  Array.from({ length: hours }, (_, i) => priceFor(c, start + i)).reduce((a, b) => a + b, 0);

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((d) => d >= istToday(-1) && d <= istToday(30), "Pick a date within the next 30 days");

/** Online bookings that were never paid give their slots back after 10 minutes. */
export async function releaseStale() {
  const stale = await Booking.find({ status: "pending", "payment.mode": "online", createdAt: { $lt: new Date(Date.now() - 10 * 60_000) } }, "_id").lean();
  if (!stale.length) return;
  const ids = stale.map((b) => b._id);
  await Booking.updateMany({ _id: { $in: ids } }, { $set: { status: "cancelled", note: "Payment not completed in time" } });
  await SlotLock.deleteMany({ booking: { $in: ids } });
}

/** Insert one lock per hour. The unique (court, date, hour) index rejects any overlap. */
export async function lockSlots(bookingId: Types.ObjectId, courtId: Types.ObjectId, date: string, startHour: number, hours: number) {
  try {
    await SlotLock.insertMany(
      Array.from({ length: hours }, (_, i) => ({ court: courtId, date, hour: startHour + i, booking: bookingId })),
      { ordered: true }
    );
  } catch (e) {
    await SlotLock.deleteMany({ booking: bookingId });
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, "Someone just booked one of these slots. Pick another time.");
    throw e;
  }
}

export const releaseSlots = (bookingId: Types.ObjectId) => SlotLock.deleteMany({ booking: bookingId });

export function checkHours(court: { openHour: number; closeHour: number }, startHour: number, hours: number) {
  if (startHour < court.openHour || startHour + hours > court.closeHour)
    throw new HttpError(400, `Open ${court.openHour}:00 to ${court.closeHour}:00 only`);
}

const venueFields = "slug name emoji theme area address location hours tagline rating followersCount kind";

/* ---------------- Venues ---------------- */
r.get("/venues", async (req, res) => {
  const { sport } = parseQuery(z.object({ sport: z.enum(SPORTS).optional() }), req.query);
  const courts = await Court.find({ active: true, ...(sport ? { sport } : {}) }).lean();
  const ids = [...new Set(courts.map((c) => String(c.business)))];
  const businesses = await Business.find({ _id: { $in: ids }, kind: "sports_venue" }, venueFields).lean();
  const items = businesses.map((b) => {
    const mine = courts.filter((c) => String(c.business) === String(b._id));
    return {
      ...b,
      courts: mine,
      sports: [...new Set(mine.map((c) => c.sport))],
      fromPrice: Math.min(...mine.map((c) => c.pricePerHour)),
    };
  });
  items.sort((a, b) => b.followersCount - a.followersCount);
  res.json({ items });
});

r.get("/venues/:slug", async (req, res) => {
  const b = await Business.findOne({ slug: req.params.slug, kind: "sports_venue" }, venueFields).lean();
  if (!b) throw notFound("Venue not found");
  const courts = await Court.find({ business: b._id, active: true }).sort({ name: 1 }).lean();
  res.json({ venue: b, courts });
});

r.get("/venues/:slug/availability", async (req, res) => {
  const { date } = parseQuery(z.object({ date: dateSchema.default(istToday()) }), req.query);
  const b = await Business.findOne({ slug: req.params.slug, kind: "sports_venue" }, "_id").lean();
  if (!b) throw notFound("Venue not found");
  await releaseStale();
  const courts = await Court.find({ business: b._id, active: true }).sort({ name: 1 }).lean();
  const locks = await SlotLock.find({ court: { $in: courts.map((c) => c._id) }, date }).lean();
  const taken = new Set(locks.map((l) => `${l.court}:${l.hour}`));
  const now = Date.now();
  res.json({
    date,
    courts: courts.map((c) => ({
      _id: c._id,
      name: c.name,
      sport: c.sport,
      slots: Array.from({ length: c.closeHour - c.openHour }, (_, i) => {
        const hour = c.openHour + i;
        const status = slotStart(date, hour).getTime() <= now ? "past" : taken.has(`${c._id}:${hour}`) ? "booked" : "free";
        return { hour, price: priceFor(c, hour), peak: isPeak(c, hour), status };
      }),
    })),
  });
});

/* ---------------- Bookings ---------------- */
r.post(
  "/bookings",
  requireAuth,
  body(
    z.object({
      courtId: z.string(),
      date: dateSchema,
      startHour: z.number().int().min(0).max(23),
      hours: z.number().int().min(1).max(4),
      payMode: z.enum(["online", "venue"]).default("online"),
      split: z.array(z.object({ name: z.string().trim().min(1).max(40), phone: z.string().trim().max(15).optional() })).max(21).default([]),
    })
  ),
  async (req, res) => {
    const { courtId, date, startHour, hours, payMode, split } = req.body;
    await releaseStale();
    const court = await Court.findOne({ _id: courtId, active: true });
    if (!court) throw notFound("Court not found");
    checkHours(court, startHour, hours);
    if (slotStart(date, startHour).getTime() <= Date.now()) throw new HttpError(400, "That time has already passed");

    const user = await User.findById(req.user!.id, "name phone").lean();
    const amount = priceForRange(court, startHour, hours);
    const people = 1 + split.length;
    const share = Math.ceil(amount / people);
    const booking = await Booking.create({
      court: court._id,
      business: court.business,
      user: req.user!.id,
      date,
      startHour,
      hours,
      amount,
      status: payMode === "venue" ? "confirmed" : "pending",
      source: "app",
      payment: { mode: payMode, status: "unpaid" },
      participants: [{ name: user?.name || "You", phone: user?.phone, share, paid: false, user: req.user!.id }, ...split.map((p: { name: string; phone?: string }) => ({ ...p, share, paid: false }))],
    });
    try {
      await lockSlots(booking._id, court._id, date, startHour, hours);
    } catch (e) {
      await booking.deleteOne();
      throw e;
    }

    if (payMode === "online") {
      const order = await createOrder(amount, `bk_${booking._id}`, { booking: String(booking._id) });
      booking.set("payment.orderId", order.orderId);
      booking.set("payment.provider", order.provider);
      await booking.save();
      res.status(201).json({ booking, order });
      return;
    }
    await afterConfirmed(booking._id);
    res.status(201).json({ booking });
  }
);

/** Notifications for a newly confirmed booking (booker + venue owner). */
async function afterConfirmed(bookingId: Types.ObjectId) {
  const b = await Booking.findById(bookingId).populate("court", "name").populate("business", "name owner slug").lean();
  if (!b) return;
  const biz = b.business as unknown as { name: string; owner?: Types.ObjectId; slug: string };
  const court = b.court as unknown as { name: string };
  const when = `${b.date} · ${b.startHour}:00–${b.startHour + b.hours}:00`;
  if (b.user) await notify([b.user], { type: "booking", emoji: "🏟️", title: `Booked: ${biz.name}`, body: `${court.name}, ${when}`, link: "/bookings" });
  if (biz.owner) await notify([biz.owner], { type: "booking", emoji: "📅", title: `New booking · ${court.name}`, body: when, link: "/merchant/venue" });
}

r.post(
  "/bookings/:id/confirm",
  requireAuth,
  body(z.object({ proof: z.object({ provider: z.enum(["mock", "razorpay"]), orderId: z.string(), paymentId: z.string().optional(), signature: z.string().optional() }) })),
  async (req, res) => {
    const booking = await Booking.findOne({ _id: req.params.id, user: req.user!.id });
    if (!booking) throw notFound("Booking not found");
    if (booking.status === "confirmed" && booking.payment?.status === "paid") {
      res.json({ booking });
      return;
    }
    if (booking.status !== "pending") throw new HttpError(410, "This booking expired. Please book again.");
    const { proof } = req.body;
    if (proof.orderId !== booking.payment?.orderId || !verifyPayment(proof)) throw new HttpError(402, "Payment could not be verified");
    const locks = await SlotLock.countDocuments({ booking: booking._id });
    if (locks !== booking.hours) throw new HttpError(410, "This booking expired. Please book again.");

    booking.status = "confirmed";
    booking.set("payment.status", "paid");
    if (booking.participants[0]) booking.participants[0].paid = true;
    await booking.save();
    await award(req.user!.id, Math.floor(booking.amount / 100) * POINTS.booking_per_100, "Paid turf booking", `booking:${booking._id}`);
    await afterConfirmed(booking._id);
    res.json({ booking });
  }
);

r.get("/bookings/me", requireAuth, async (req, res) => {
  const items = await Booking.find({ user: req.user!.id, source: "app", status: { $ne: "pending" } })
    .sort({ date: -1, startHour: -1 })
    .limit(50)
    .populate("court", "name sport")
    .populate("business", "slug name emoji theme area location")
    .populate("game", "spots players status pricePerHead skill")
    .lean();
  res.json({
    items: items.map((b) => ({ ...b, startsAt: slotStart(b.date, b.startHour), upcoming: slotStart(b.date, b.startHour + b.hours).getTime() > Date.now() })),
  });
});

r.post("/bookings/:id/cancel", requireAuth, async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.id, user: req.user!.id });
  if (!booking) throw notFound("Booking not found");
  if (!["pending", "confirmed"].includes(booking.status)) throw new HttpError(409, "This booking can't be cancelled");
  if (booking.status === "confirmed" && slotStart(booking.date, booking.startHour).getTime() - Date.now() < 2 * 3_600_000)
    throw new HttpError(409, "Free cancellation closes 2 hours before start. Call the venue.");
  booking.status = "cancelled";
  if (booking.payment?.status === "paid") booking.set("payment.status", "refund_due");
  await booking.save();
  await releaseSlots(booking._id);
  if (booking.game) {
    const g = await OpenGame.findByIdAndUpdate(booking.game, { $set: { status: "cancelled" } });
    if (g?.players.length) await notify(g.players, { type: "game", emoji: "😕", title: "Open game cancelled", body: "The host cancelled the booking.", link: "/play" });
  }
  res.json({ booking });
});

r.post("/bookings/:id/participants/:i/paid", requireAuth, async (req, res) => {
  const i = Number(req.params.i);
  const booking = await Booking.findOne({ _id: req.params.id, user: req.user!.id });
  if (!booking) throw notFound("Booking not found");
  const p = booking.participants[i];
  if (!p || i === 0) throw new HttpError(400, "No such friend on this booking");
  p.paid = !p.paid;
  await booking.save();
  res.json({ booking });
});

/* ---------------- Open games ---------------- */
r.get("/games", optionalAuth, async (req, res) => {
  const { sport } = parseQuery(z.object({ sport: z.enum(SPORTS).optional() }), req.query);
  const games = await OpenGame.find({ status: { $in: ["open", "full"] }, startsAt: { $gt: new Date() }, ...(sport ? { sport } : {}) })
    .sort({ startsAt: 1 })
    .limit(30)
    .populate("business", "slug name emoji theme area")
    .populate("court", "name")
    .populate("host", "name")
    .populate("booking", "hours")
    .lean();
  const uid = req.user?.id;
  res.json({
    items: games.map((g) => ({
      ...g,
      players: undefined,
      playerCount: g.players.length,
      spotsLeft: Math.max(0, g.spots - g.players.length),
      joined: !!uid && g.players.some((p) => String(p) === uid),
      isHost: !!uid && String((g.host as unknown as { _id: unknown })._id) === uid,
    })),
  });
});

r.post(
  "/games",
  requireAuth,
  body(
    z.object({
      bookingId: z.string(),
      spots: z.number().int().min(1).max(20),
      pricePerHead: z.number().min(0).max(5000).default(0),
      skill: z.enum(["beginner", "intermediate", "advanced", "any"]).default("any"),
      note: z.string().trim().max(200).optional(),
    })
  ),
  async (req, res) => {
    const booking = await Booking.findOne({ _id: req.body.bookingId, user: req.user!.id, status: "confirmed" }).populate("court", "sport");
    if (!booking) throw notFound("Confirmed booking not found");
    const startsAt = slotStart(booking.date, booking.startHour);
    if (startsAt.getTime() <= Date.now()) throw new HttpError(400, "This booking has already started");
    if (booking.game) throw new HttpError(409, "You already opened a game for this booking");
    const court = booking.court as unknown as { _id: Types.ObjectId; sport: (typeof SPORTS)[number] };
    const game = await OpenGame.create({
      booking: booking._id,
      business: booking.business,
      court: court._id,
      host: req.user!.id,
      sport: court.sport,
      skill: req.body.skill,
      spots: req.body.spots,
      pricePerHead: req.body.pricePerHead,
      note: req.body.note,
      startsAt,
    });
    booking.game = game._id;
    await booking.save();
    res.status(201).json({ game });
  }
);

r.post("/games/:id/join", requireAuth, async (req, res) => {
  const uid = req.user!.id;
  const game = await OpenGame.findById(req.params.id).populate("business", "name");
  if (!game || game.status === "cancelled") throw notFound("Game not found");
  if (game.startsAt.getTime() <= Date.now()) throw new HttpError(409, "This game has already started");
  if (String(game.host) === uid) throw new HttpError(400, "You're hosting this game");

  // leave
  const left = await OpenGame.updateOne({ _id: game._id, players: uid }, { $pull: { players: uid }, $set: { status: "open" } });
  if (left.modifiedCount) {
    res.json({ joined: false });
    return;
  }
  // join atomically, only while spots remain
  const joined = await OpenGame.updateOne(
    { _id: game._id, status: "open", players: { $ne: uid }, $expr: { $lt: [{ $size: "$players" }, "$spots"] } },
    { $push: { players: uid } }
  );
  if (!joined.modifiedCount) throw new HttpError(409, "Sorry, this game just filled up");
  await OpenGame.updateOne({ _id: game._id, $expr: { $gte: [{ $size: "$players" }, "$spots"] } }, { $set: { status: "full" } });

  const me = await User.findById(uid, "name").lean();
  const venueName = (game.business as unknown as { name: string }).name;
  await notify([game.host], { type: "game", emoji: "🙌", title: `${me?.name ?? "A player"} joined your game`, body: venueName, link: "/bookings" });
  await award(uid, POINTS.open_game, "Joined an open game", `game:${game._id}:${uid}`);
  res.json({ joined: true });
});

export default r;
