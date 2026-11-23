import { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { body, HttpError, notFound, parseQuery } from "../lib/http.js";
import { award, POINTS } from "../lib/points.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { Business } from "../models/index.js";
import { Booking, Court, SlotLock, SPORTS } from "../models/play.js";
import { checkHours, dateSchema, isPeak, istToday, lockSlots, priceFor, priceForRange, releaseSlots, releaseStale, slotStart } from "./play.js";

/* Venue-owner tools: courts & pricing, day calendar, walk-ins, blocks, day summary. */
const r = Router();
r.use(requireAuth, requireRole("merchant", "admin"));

const myVenueIds = async (user: { id: string; role: string }) => {
  const filter: Record<string, unknown> = user.role === "admin" ? { kind: "sports_venue" } : { kind: "sports_venue", owner: user.id };
  return (await Business.find(filter, "_id").lean()).map((b) => String(b._id));
};

const ownVenue = async (user: { id: string; role: string }, businessId?: string) => {
  const ids = await myVenueIds(user);
  if (!ids.length) throw new HttpError(404, "No sports venue on this account");
  const id = businessId ?? ids[0];
  if (!ids.includes(String(id))) throw new HttpError(403, "Not your venue");
  return id;
};

const ownCourt = async (user: { id: string; role: string }, courtId: string) => {
  const court = await Court.findById(courtId);
  if (!court) throw notFound("Court not found");
  await ownVenue(user, String(court.business));
  return court;
};

r.get("/venues", async (req, res) => {
  const ids = await myVenueIds(req.user!);
  const items = await Business.find({ _id: { $in: ids } }, "slug name emoji theme area").sort({ name: 1 }).lean();
  res.json({ items });
});

/* ---------------- Courts ---------------- */
const courtBody = z.object({
  name: z.string().trim().min(1).max(40),
  sport: z.enum(SPORTS),
  pricePerHour: z.number().min(0).max(20000),
  peakPricePerHour: z.number().min(0).max(20000),
  peakFrom: z.number().int().min(0).max(24),
  peakTo: z.number().int().min(0).max(24),
  openHour: z.number().int().min(0).max(23),
  closeHour: z.number().int().min(1).max(24),
  active: z.boolean(),
});

r.get("/courts", async (req, res) => {
  const { business } = parseQuery(z.object({ business: z.string().optional() }), req.query);
  const id = await ownVenue(req.user!, business);
  const items = await Court.find({ business: id }).sort({ name: 1 }).lean();
  res.json({ items });
});

r.post("/courts", body(courtBody.partial({ active: true, peakFrom: true, peakTo: true, openHour: true, closeHour: true }).extend({ business: z.string() })), async (req, res) => {
  const id = await ownVenue(req.user!, req.body.business);
  if (req.body.openHour !== undefined && req.body.closeHour !== undefined && req.body.closeHour <= req.body.openHour)
    throw new HttpError(400, "Closing hour must be after opening hour");
  const court = await Court.create({ ...req.body, business: id });
  res.status(201).json({ court });
});

r.patch("/courts/:id", body(courtBody.partial()), async (req, res) => {
  const court = await ownCourt(req.user!, String(req.params.id));
  court.set(req.body);
  if (court.closeHour <= court.openHour) throw new HttpError(400, "Closing hour must be after opening hour");
  await court.save();
  res.json({ court });
});

/* ---------------- Calendar ---------------- */
r.get("/calendar", async (req, res) => {
  const { business, date } = parseQuery(z.object({ business: z.string().optional(), date: dateSchema.default(istToday()) }), req.query);
  const id = await ownVenue(req.user!, business);
  await releaseStale();
  const courts = await Court.find({ business: id, active: true }).sort({ name: 1 }).lean();
  const bookings = await Booking.find({ business: id, date, status: { $ne: "cancelled" } }).lean();
  const now = Date.now();
  res.json({
    date,
    courts: courts.map((c) => ({
      _id: c._id,
      name: c.name,
      sport: c.sport,
      slots: Array.from({ length: c.closeHour - c.openHour }, (_, i) => {
        const hour = c.openHour + i;
        const b = bookings.find((x) => String(x.court) === String(c._id) && hour >= x.startHour && hour < x.startHour + x.hours);
        return {
          hour,
          price: priceFor(c, hour),
          peak: isPeak(c, hour),
          past: slotStart(date, hour + 1).getTime() <= now,
          booking: b
            ? {
                _id: b._id,
                isStart: hour === b.startHour,
                startHour: b.startHour,
                hours: b.hours,
                source: b.source,
                status: b.status,
                amount: b.amount,
                name: b.participants[0]?.name ?? (b.source === "blocked" ? "Blocked" : "Guest"),
                phone: b.participants[0]?.phone,
                players: b.participants.length,
                payment: b.payment,
                note: b.note,
              }
            : null,
        };
      }),
    })),
  });
});

/* ---------------- Walk-ins & blocks ---------------- */
const slotBody = z.object({
  courtId: z.string(),
  date: dateSchema,
  startHour: z.number().int().min(0).max(23),
  hours: z.number().int().min(1).max(4),
});

async function ownerBooking(
  user: { id: string; role: string },
  input: z.infer<typeof slotBody>,
  extra: { source: "walkin" | "blocked"; name: string; phone?: string; paid: boolean; note?: string }
) {
  const court = await ownCourt(user, input.courtId);
  checkHours(court, input.startHour, input.hours);
  if (slotStart(input.date, input.startHour + input.hours).getTime() <= Date.now()) throw new HttpError(400, "That time has already passed");
  await releaseStale();
  const amount = extra.source === "blocked" ? 0 : priceForRange(court, input.startHour, input.hours);
  const booking = await Booking.create({
    court: court._id,
    business: court.business,
    date: input.date,
    startHour: input.startHour,
    hours: input.hours,
    amount,
    status: "confirmed",
    source: extra.source,
    note: extra.note,
    payment: { mode: "venue", status: extra.paid ? "paid" : "unpaid" },
    participants: [{ name: extra.name, phone: extra.phone, share: amount, paid: extra.paid }],
  });
  try {
    await lockSlots(booking._id as Types.ObjectId, court._id, input.date, input.startHour, input.hours);
  } catch (e) {
    await booking.deleteOne();
    throw e;
  }
  return booking;
}

r.post(
  "/walkin",
  body(slotBody.extend({ name: z.string().trim().min(1).max(40), phone: z.string().trim().max(15).optional(), paid: z.boolean().default(false) })),
  async (req, res) => {
    const { name, phone, paid, ...slot } = req.body;
    const booking = await ownerBooking(req.user!, slot, { source: "walkin", name, phone, paid });
    res.status(201).json({ booking });
  }
);

r.post("/block", body(slotBody.extend({ reason: z.string().trim().max(80).default("Maintenance") })), async (req, res) => {
  const { reason, ...slot } = req.body;
  const booking = await ownerBooking(req.user!, slot, { source: "blocked", name: reason, paid: false, note: reason });
  res.status(201).json({ booking });
});

r.patch(
  "/bookings/:id",
  body(z.object({ status: z.enum(["completed", "no_show", "cancelled"]), paid: z.boolean().optional() })),
  async (req, res) => {
    const booking = await Booking.findById(req.params.id);
    if (!booking) throw notFound("Booking not found");
    await ownVenue(req.user!, String(booking.business));
    if (booking.status === "cancelled") throw new HttpError(409, "Already cancelled");
    booking.status = req.body.status;
    if (req.body.paid !== undefined && booking.payment?.mode === "venue") booking.set("payment.status", req.body.paid ? "paid" : "unpaid");
    if (req.body.status === "completed" && booking.payment?.mode === "venue" && req.body.paid !== false) booking.set("payment.status", "paid");
    if (req.body.status === "cancelled" && booking.payment?.status === "paid" && booking.payment.mode === "online") booking.set("payment.status", "refund_due");
    await booking.save();
    if (req.body.status === "cancelled") await releaseSlots(booking._id);
    if (req.body.status === "completed" && booking.user)
      await award(booking.user, Math.max(1, Math.floor(booking.amount / 100)) * POINTS.booking_per_100, "Played at a venue", `booking:${booking._id}`);
    res.json({ booking });
  }
);

/* ---------------- Day summary ---------------- */
r.get("/summary", async (req, res) => {
  const { business, date } = parseQuery(z.object({ business: z.string().optional(), date: dateSchema.default(istToday()) }), req.query);
  const id = await ownVenue(req.user!, business);
  const [courts, bookings, lockedHours] = await Promise.all([
    Court.find({ business: id, active: true }).lean(),
    Booking.find({ business: id, date, status: { $in: ["confirmed", "completed", "no_show", "pending"] } }).lean(),
    SlotLock.countDocuments({ court: { $in: (await Court.find({ business: id, active: true }, "_id").lean()).map((c) => c._id) }, date }),
  ]);
  const totalHours = courts.reduce((s, c) => s + (c.closeHour - c.openHour), 0);
  const real = bookings.filter((b) => b.source !== "blocked");
  res.json({
    date,
    bookings: real.length,
    walkins: real.filter((b) => b.source === "walkin").length,
    revenue: real.filter((b) => b.status !== "no_show").reduce((s, b) => s + b.amount, 0),
    collected: real.filter((b) => b.payment?.status === "paid").reduce((s, b) => s + b.amount, 0),
    noShows: real.filter((b) => b.status === "no_show").length,
    utilisation: totalHours ? Math.round((lockedHours / totalHours) * 100) : 0,
    bookedHours: lockedHours,
    totalHours,
  });
});

export default r;
