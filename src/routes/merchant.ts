import { Router } from "express";
import { z } from "zod";
import { body, HttpError, notFound } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { Business, Claim, Deal, User } from "../models/index.js";
import { notify } from "../lib/notify.js";
import { award, POINTS } from "../lib/points.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const followersOf = async (businessId: unknown) => {
  const filter: Record<string, unknown> = { follows: businessId };
  return (await User.find(filter, "_id").lean()).map((u) => u._id);
};

/* Tools for business owners: go live, redeem coupons, create deals, see results. */
const r = Router();
r.use(requireAuth, requireRole("merchant", "admin"));

const owned = async (id: string, userId: string, role: string) => {
  const b = await Business.findOne(role === "admin" ? { _id: id } : { _id: id, owner: userId });
  if (!b) throw notFound("Business not found");
  return b;
};

r.get("/businesses", async (req, res) => {
  const filter = req.user!.role === "admin" ? {} : { owner: req.user!.id };
  const items = await Business.find(filter).sort({ name: 1 }).lean();
  res.json({ items });
});

r.post(
  "/businesses/:id/live",
  body(z.object({ lng: z.number(), lat: z.number(), spot: z.string().trim().min(2).max(80), hours: z.number().min(0.5).max(16).default(4) })),
  async (req, res) => {
    const b = await owned(String(req.params.id), req.user!.id, req.user!.role);
    const { lng, lat, spot, hours } = req.body;
    b.set("live", {
      isLive: true,
      spot,
      location: { type: "Point", coordinates: [lng, lat] },
      until: new Date(Date.now() + hours * 3_600_000),
      updatedAt: new Date(),
    });
    await b.save();
    await notify(await followersOf(b._id), { type: "truck_live", emoji: b.emoji, title: `${b.name} is live now`, body: `📍 ${spot} · serving for ${hours}h`, link: `/b/${b.slug}` });
    res.json({ live: b.live });
  }
);

r.delete("/businesses/:id/live", async (req, res) => {
  const b = await owned(String(req.params.id), req.user!.id, req.user!.role);
  b.set("live.isLive", false);
  b.set("live.updatedAt", new Date());
  await b.save();
  res.json({ live: b.live });
});

r.post(
  "/businesses/:id/deals",
  body(
    z.object({
      title: z.string().trim().min(3).max(80),
      description: z.string().trim().max(240).optional(),
      kind: z.enum(["first_n", "percent", "flat", "bogo", "freebie"]).default("percent"),
      value: z.number().min(0).default(0),
      limit: z.number().int().min(1).max(10000).default(100),
      days: z.number().min(1).max(90).default(7),
    })
  ),
  async (req, res) => {
    const b = await owned(String(req.params.id), req.user!.id, req.user!.role);
    const { days, ...rest } = req.body;
    const deal = await Deal.create({ ...rest, business: b._id, endsAt: new Date(Date.now() + days * 86_400_000) });
    await notify(await followersOf(b._id), { type: "new_deal", emoji: "🎟️", title: `New at ${b.name}: ${deal.title}`, body: `${deal.limit} coupons · claim before they're gone`, link: `/b/${b.slug}` });
    res.status(201).json({ deal });
  }
);

r.get("/businesses/:id/stats", async (req, res) => {
  const b = await owned(String(req.params.id), req.user!.id, req.user!.role);
  const [deals, recent] = await Promise.all([
    Deal.find({ business: b._id }).sort({ createdAt: -1 }).lean(),
    Claim.find({ business: b._id, status: "redeemed" }).sort({ redeemedAt: -1 }).limit(10).populate("deal", "title").lean(),
  ]);
  const claimed = deals.reduce((s, d) => s + d.claimedCount, 0);
  const redeemed = deals.reduce((s, d) => s + d.redeemedCount, 0);
  res.json({
    followers: b.followersCount,
    notify: b.opening?.notifyCount ?? 0,
    claimed,
    redeemed,
    conversion: claimed ? Math.round((redeemed / claimed) * 100) : 0,
    deals,
    recent,
  });
});

/** Cover photo, sent as a base64 data URL (≤3 MB). Stored on local disk; swap for S3/R2 in production. */
r.post("/businesses/:id/photo", body(z.object({ dataUrl: z.string().max(4_200_000) })), async (req, res) => {
  const b = await owned(String(req.params.id), req.user!.id, req.user!.role);
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(req.body.dataUrl);
  if (!m) throw new HttpError(400, "Upload a JPG, PNG or WebP image");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 3_000_000) throw new HttpError(413, "Image must be under 3 MB");
  const file = `${b._id}-${Date.now()}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  await writeFile(path.resolve("uploads", file), buf);
  b.set("photo", `/uploads/${file}`);
  await b.save();
  res.json({ photo: b.photo });
});

/** Shop counter scans/enters the customer's code. */
r.post("/redeem", body(z.object({ code: z.string().trim().toUpperCase().length(6) })), async (req, res) => {
  const claim = await Claim.findOne({ code: req.body.code }).populate("deal", "title endsAt").populate("business", "name owner");
  if (!claim) throw new HttpError(404, "Code not found");
  const biz = claim.business as unknown as { _id: unknown; name: string; owner?: unknown };
  if (req.user!.role !== "admin" && String(biz.owner) !== req.user!.id) throw new HttpError(403, "This code belongs to another business");
  if (claim.status === "redeemed") throw new HttpError(409, `Already used on ${claim.redeemedAt?.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);

  const done = await Claim.updateOne({ _id: claim._id, status: "claimed" }, { $set: { status: "redeemed", redeemedAt: new Date() } });
  if (!done.modifiedCount) throw new HttpError(409, "Already used");
  await Deal.updateOne({ _id: (claim.deal as unknown as { _id: unknown })._id }, { $inc: { redeemedCount: 1 } });
  await award(claim.user, POINTS.redeem, `Redeemed at ${biz.name}`, `redeem:${claim._id}`);
  res.json({ ok: true, deal: claim.deal, business: biz.name });
});

export default r;
