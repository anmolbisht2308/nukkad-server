import { Router } from "express";
import { z } from "zod";
import { CITIES } from "../lib/cities.js";
import { body, HttpError, notFound, parseQuery } from "../lib/http.js";
import { notify } from "../lib/notify.js";
import { tierFor } from "../lib/points.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { Business, Deal, User } from "../models/index.js";
import { Campaign, Creator, Notification, PointsEntry } from "../models/social.js";

/* Notifications, Nukkad Points, cities, and the creator marketplace. */
const r = Router();

/* ---------- Cities ---------- */
r.get("/cities", async (_req, res) => {
  const counts = await Business.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$city", n: { $sum: 1 } } }]);
  const by = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  res.json({ cities: CITIES.map((c) => ({ ...c, places: by[c.slug] ?? 0 })) });
});

/* ---------- Notifications ---------- */
r.get("/me/notifications", requireAuth, async (req, res) => {
  const [items, unread] = await Promise.all([
    Notification.find({ user: req.user!.id }).sort({ createdAt: -1 }).limit(50).lean(),
    Notification.countDocuments({ user: req.user!.id, read: false }),
  ]);
  res.json({ items, unread });
});

r.get("/me/notifications/unread", requireAuth, async (req, res) => {
  res.json({ unread: await Notification.countDocuments({ user: req.user!.id, read: false }) });
});

r.post("/me/notifications/read", requireAuth, async (req, res) => {
  await Notification.updateMany({ user: req.user!.id, read: false }, { $set: { read: true } });
  res.json({ ok: true });
});

/* ---------- Points ---------- */
r.get("/me/points", requireAuth, async (req, res) => {
  const [u, history] = await Promise.all([
    User.findById(req.user!.id, "points name").lean(),
    PointsEntry.find({ user: req.user!.id }).sort({ createdAt: -1 }).limit(30).lean(),
  ]);
  const points = u?.points ?? 0;
  res.json({ points, tier: tierFor(points), history });
});

r.get("/leaderboard", async (req, res) => {
  const { city } = parseQuery(z.object({ city: z.string().default("bareilly") }), req.query);
  const top = await User.find({ city, points: { $gt: 0 } }, "name points").sort({ points: -1 }).limit(10).lean();
  res.json({ top: top.map((u) => ({ name: u.name ?? "Player", points: u.points, tier: tierFor(u.points ?? 0) })) });
});

/* ---------- Creators ---------- */
r.get("/creators", async (req, res) => {
  const q = parseQuery(z.object({ niche: z.string().optional(), city: z.string().default("bareilly") }), req.query);
  const filter: Record<string, unknown> = { city: q.city };
  if (q.niche) filter.niches = q.niche;
  const items = await Creator.find(filter).sort({ followers: -1 }).lean();
  res.json({ items });
});

r.get("/creators/me", requireAuth, async (req, res) => {
  const creator = await Creator.findOne({ user: req.user!.id }).lean();
  const campaigns = creator
    ? await Campaign.find({ creator: creator._id }).sort({ createdAt: -1 }).populate("business", "slug name emoji theme area").populate("deal", "title claimedCount redeemedCount limit").lean()
    : [];
  res.json({ creator, campaigns });
});

r.post(
  "/creators/me",
  requireAuth,
  body(
    z.object({
      handle: z.string().trim().regex(/^@?[a-zA-Z0-9._]{3,30}$/, "Use letters, numbers, dots or underscores"),
      name: z.string().trim().min(2).max(60),
      platform: z.enum(["instagram", "youtube", "facebook", "moj"]).default("instagram"),
      followers: z.number().int().min(0).max(50_000_000),
      niches: z.array(z.string().trim().max(20)).max(5).default([]),
      area: z.string().trim().max(60).optional(),
      ratePerPost: z.number().int().min(0).max(1_000_000),
      bio: z.string().trim().max(280).optional(),
    })
  ),
  async (req, res) => {
    const data = { ...req.body, handle: req.body.handle.replace(/^@/, "").toLowerCase() };
    const creator = await Creator.findOneAndUpdate({ user: req.user!.id }, { $set: data, $setOnInsert: { user: req.user!.id } }, { upsert: true, returnDocument: "after" });
    res.json({ creator });
  }
);

r.get("/creators/:handle", async (req, res) => {
  const creator = await Creator.findOne({ handle: req.params.handle.toLowerCase() }).lean();
  if (!creator) throw notFound("Creator not found");
  res.json({ creator });
});

/* ---------- Campaigns: business hires a creator; each gets a tracked deal ---------- */
r.post(
  "/campaigns",
  requireAuth,
  requireRole("merchant", "admin"),
  body(z.object({ businessId: z.string(), creatorId: z.string(), brief: z.string().trim().min(10).max(600), budget: z.number().int().min(100).max(1_000_000) })),
  async (req, res) => {
    const biz = await Business.findOne(req.user!.role === "admin" ? { _id: req.body.businessId } : { _id: req.body.businessId, owner: req.user!.id });
    if (!biz) throw notFound("Business not found");
    const creator = await Creator.findById(req.body.creatorId);
    if (!creator) throw notFound("Creator not found");
    // inactive until the creator accepts
    const deal = await Deal.create({
      business: biz._id,
      title: `@${creator.handle} special: 15% off`,
      description: `Seen on @${creator.handle}'s post? Claim this to get 15% off.`,
      kind: "percent",
      value: 15,
      limit: 200,
      active: false,
      endsAt: new Date(Date.now() + 21 * 86_400_000),
    });
    const c = await Campaign.create({ business: biz._id, creator: creator._id, brief: req.body.brief, budget: req.body.budget, deal: deal._id });
    await notify([creator.user], { type: "campaign", emoji: "📣", title: `${biz.name} wants to work with you`, body: `₹${req.body.budget} · ${req.body.brief.slice(0, 80)}`, link: "/creator" });
    res.status(201).json({ campaign: c });
  }
);

r.get("/merchant-campaigns", requireAuth, requireRole("merchant", "admin"), async (req, res) => {
  const mine = await Business.find(req.user!.role === "admin" ? {} : { owner: req.user!.id }, "_id").lean();
  const items = await Campaign.find({ business: { $in: mine.map((b) => b._id) } })
    .sort({ createdAt: -1 })
    .populate("business", "slug name emoji")
    .populate("creator", "handle name followers emoji")
    .populate("deal", "title claimedCount redeemedCount limit")
    .lean();
  res.json({ items });
});

const loadForCreator = async (id: string, userId: string) => {
  const c = await Campaign.findById(id).populate<{ creator: { user: unknown; handle: string } }>("creator", "user handle").populate<{ business: { owner: unknown; name: string; slug: string } }>("business", "owner name slug");
  if (!c) throw notFound("Campaign not found");
  if (String(c.creator.user) !== userId) throw new HttpError(403, "Not your campaign");
  return c;
};

r.post("/campaigns/:id/respond", requireAuth, body(z.object({ accept: z.boolean() })), async (req, res) => {
  const c = await loadForCreator(String(req.params.id), req.user!.id);
  if (c.status !== "requested") throw new HttpError(409, "Already answered");
  c.status = req.body.accept ? "accepted" : "declined";
  await c.save();
  if (req.body.accept) await Deal.updateOne({ _id: c.deal }, { $set: { active: true, startsAt: new Date() } });
  await notify([c.business.owner as string], {
    type: "campaign",
    emoji: req.body.accept ? "🤝" : "🙅",
    title: `@${c.creator.handle} ${req.body.accept ? "accepted" : "declined"} your campaign`,
    link: "/merchant",
  });
  res.json({ campaign: c });
});

r.post("/campaigns/:id/posted", requireAuth, body(z.object({ postUrl: z.string().url().max(300) })), async (req, res) => {
  const c = await loadForCreator(String(req.params.id), req.user!.id);
  if (c.status !== "accepted") throw new HttpError(409, "Accept the campaign first");
  c.status = "posted";
  c.postUrl = req.body.postUrl;
  await c.save();
  await notify([c.business.owner as string], { type: "campaign", emoji: "📸", title: `@${c.creator.handle} posted about ${c.business.name}`, link: "/merchant" });
  res.json({ campaign: c });
});

r.post("/campaigns/:id/complete", requireAuth, requireRole("merchant", "admin"), async (req, res) => {
  const c = await Campaign.findById(req.params.id).populate<{ business: { owner: unknown } }>("business", "owner");
  if (!c) throw notFound("Campaign not found");
  if (req.user!.role !== "admin" && String(c.business.owner) !== req.user!.id) throw new HttpError(403, "Not your campaign");
  if (c.status !== "posted") throw new HttpError(409, "The creator hasn't posted yet");
  c.status = "completed";
  await c.save();
  const cr = await Creator.findByIdAndUpdate(c.creator, { $inc: { completed: 1 } });
  if (cr) await notify([cr.user], { type: "campaign", emoji: "✅", title: "Campaign marked complete", body: `₹${c.budget} payout is on its way`, link: "/creator" });
  res.json({ campaign: c });
});

export default r;
