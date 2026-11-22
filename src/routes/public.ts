import { Router } from "express";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { body, HttpError, normalizePhone, notFound, parseQuery } from "../lib/http.js";
import { daysAgo, window, type When } from "../lib/time.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { BUSINESS_KINDS, Business, Claim, Deal, Event, User, Waitlist } from "../models/index.js";
import { award, POINTS } from "../lib/points.js";

const r = Router();
const couponCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

const liveFilter = () => ({ "live.isLive": true, "live.until": { $gt: new Date() } });
const activeDeal = () => ({ active: true, startsAt: { $lte: new Date() }, endsAt: { $gt: new Date() }, $expr: { $lt: ["$claimedCount", "$limit"] } });

/* ---------- Feed: everything happening in the city for a time window ---------- */
r.get("/feed", async (req, res) => {
  const { when, city } = parseQuery(
    z.object({ when: z.enum(["today", "tonight", "weekend", "week"]).default("today"), city: z.string().default("bareilly") }),
    req.query
  );
  const { from, to } = window(when as When);

  const [liveTrucks, newOpenings, comingSoon, deals, events] = await Promise.all([
    Business.find({ city, ...liveFilter() }).sort({ "live.updatedAt": -1 }).limit(12).lean(),
    Business.find({ city, "opening.status": "open", "opening.date": { $gte: daysAgo(21), $lte: new Date() } }).sort({ "opening.date": -1 }).limit(8).lean(),
    Business.find({ city, "opening.status": "coming_soon" }).sort({ "opening.date": 1 }).limit(8).lean(),
    Deal.find(activeDeal()).sort({ claimedCount: -1 }).limit(10).populate("business", "slug name emoji theme area kind").lean(),
    Event.find({ city, startsAt: { $gte: from, $lte: to } }).sort({ startsAt: 1 }).limit(12).lean(),
  ]);
  res.json({ when, window: { from, to }, liveTrucks, newOpenings, comingSoon, deals, events });
});

/* ---------- Stats for the landing page ---------- */
r.get("/stats", async (_req, res) => {
  const [live, businesses, deals, events, waitlist] = await Promise.all([
    Business.countDocuments(liveFilter()),
    Business.countDocuments(),
    Deal.countDocuments(activeDeal()),
    Event.countDocuments({ startsAt: { $gte: new Date() } }),
    Waitlist.countDocuments(),
  ]);
  res.json({ live, businesses, deals, events, waitlist });
});

/* ---------- Businesses ---------- */
r.get("/businesses", async (req, res) => {
  const q = parseQuery(
    z.object({
      kind: z.enum(BUSINESS_KINDS).optional(),
      q: z.string().trim().max(60).optional(),
      lng: z.coerce.number().optional(),
      lat: z.coerce.number().optional(),
      km: z.coerce.number().max(50).default(10),
      limit: z.coerce.number().max(50).default(24),
      city: z.string().default("bareilly"),
    }),
    req.query
  );
  const filter: Record<string, unknown> = { city: q.city };
  if (q.kind) filter.kind = q.kind;
  if (q.q) filter.$text = { $search: q.q };
  if (q.lng !== undefined && q.lat !== undefined && !q.q)
    filter.location = { $near: { $geometry: { type: "Point", coordinates: [q.lng, q.lat] }, $maxDistance: q.km * 1000 } };
  const items = await Business.find(filter).limit(q.limit).lean();
  res.json({ items });
});

r.get("/businesses/:slug", optionalAuth, async (req, res) => {
  const b = await Business.findOne({ slug: req.params.slug }).lean();
  if (!b) throw notFound("Business not found");
  const deals = await Deal.find({ business: b._id, ...activeDeal() }).sort({ endsAt: 1 }).lean();
  let me: { following: boolean; notified: boolean; claims: Record<string, string> } | undefined;
  if (req.user) {
    const [u, notified, claims] = await Promise.all([
      User.findById(req.user.id, "follows").lean(),
      Business.exists({ _id: b._id, "opening.notifyList": req.user.id }),
      Claim.find({ user: req.user.id, business: b._id }, "deal code").lean(),
    ]);
    me = {
      following: !!u?.follows?.some((f) => String(f) === String(b._id)),
      notified: !!notified,
      claims: Object.fromEntries(claims.map((c) => [String(c.deal), c.code])),
    };
  }
  res.json({ business: b, deals, me });
});

r.post("/businesses/:slug/follow", requireAuth, async (req, res) => {
  const b = await Business.findOne({ slug: req.params.slug }, "_id");
  if (!b) throw notFound("Business not found");
  const added = await User.updateOne({ _id: req.user!.id, follows: { $ne: b._id } }, { $push: { follows: b._id } });
  if (added.modifiedCount) {
    await Business.updateOne({ _id: b._id }, { $inc: { followersCount: 1 } });
    res.json({ following: true });
    return;
  }
  await User.updateOne({ _id: req.user!.id }, { $pull: { follows: b._id } });
  await Business.updateOne({ _id: b._id, followersCount: { $gt: 0 } }, { $inc: { followersCount: -1 } });
  res.json({ following: false });
});

r.post("/businesses/:slug/notify", requireAuth, async (req, res) => {
  const upd = await Business.updateOne(
    { slug: req.params.slug, "opening.status": "coming_soon", "opening.notifyList": { $ne: req.user!.id } },
    { $push: { "opening.notifyList": req.user!.id }, $inc: { "opening.notifyCount": 1 } }
  );
  res.json({ notified: true, added: upd.modifiedCount > 0 });
});

/* ---------- Deals & coupons ---------- */
r.post("/deals/:id/claim", requireAuth, async (req, res) => {
  const existing = await Claim.findOne({ deal: req.params.id, user: req.user!.id }).lean();
  if (existing) {
    res.json({ claim: existing });
    return;
  }
  // atomic: only increments if the deal is still live and under its limit
  const deal = await Deal.findOneAndUpdate({ _id: req.params.id, ...activeDeal() }, { $inc: { claimedCount: 1 } }, { returnDocument: "after" });
  if (!deal) throw new HttpError(410, "This deal has ended or is fully claimed");
  try {
    const claim = await Claim.create({ deal: deal._id, business: deal.business, user: req.user!.id, code: couponCode() });
    res.status(201).json({ claim });
  } catch (e) {
    await Deal.updateOne({ _id: deal._id }, { $inc: { claimedCount: -1 } });
    throw e;
  }
});

r.get("/me/claims", requireAuth, async (req, res) => {
  const claims = await Claim.find({ user: req.user!.id })
    .sort({ createdAt: -1 })
    .populate("deal", "title description endsAt")
    .populate("business", "slug name emoji theme area")
    .lean();
  res.json({ claims });
});

/* ---------- Events ---------- */
r.get("/events", async (req, res) => {
  const { when, kind } = parseQuery(z.object({ when: z.enum(["today", "tonight", "weekend", "week"]).default("week"), kind: z.string().optional() }), req.query);
  const { from, to } = window(when as When);
  const filter: Record<string, unknown> = { startsAt: { $gte: from, $lte: to } };
  if (kind) filter.kind = kind;
  const events = await Event.find(filter).sort({ startsAt: 1 }).lean();
  res.json({ events });
});

r.post("/events/:slug/rsvp", requireAuth, async (req, res) => {
  const uid = req.user!.id;
  const joined = await Event.updateOne(
    { slug: req.params.slug, attendees: { $ne: uid }, $expr: { $lt: ["$rsvpCount", "$capacity"] } },
    { $push: { attendees: uid }, $inc: { rsvpCount: 1 } }
  );
  if (joined.modifiedCount) {
    const ev = await Event.findOne({ slug: req.params.slug }, "title").lean();
    await award(uid, POINTS.rsvp, `RSVP: ${ev?.title ?? "event"}`, `rsvp:${req.params.slug}:${uid}`);
    res.json({ going: true });
    return;
  }
  const left = await Event.updateOne({ slug: req.params.slug, attendees: uid }, { $pull: { attendees: uid }, $inc: { rsvpCount: -1 } });
  if (!left.modifiedCount) throw new HttpError(409, "This event is full");
  res.json({ going: false });
});

/* ---------- Waitlist ---------- */
r.post(
  "/waitlist",
  body(
    z.object({
      phone: z.string(),
      name: z.string().trim().max(60).optional(),
      role: z.enum(["player", "foodie", "business", "venue", "organizer"]).default("foodie"),
      area: z.string().trim().max(60).optional(),
    })
  ),
  async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    await Waitlist.updateOne({ phone }, { $set: { ...req.body, phone } }, { upsert: true });
    const position = await Waitlist.countDocuments();
    res.status(201).json({ ok: true, position });
  }
);

export default r;
