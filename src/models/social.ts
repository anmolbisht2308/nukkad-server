import mongoose, { Schema } from "mongoose";

/* ---------------- In-app notifications ---------------- */
const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, required: true }, // truck_live, opening_day, new_deal, booking, game, tournament, campaign, points
    title: { type: String, required: true },
    body: String,
    link: String,
    emoji: { type: String, default: "🔔" },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);
notificationSchema.index({ user: 1, createdAt: -1 });
export const Notification = mongoose.model("Notification", notificationSchema);

/* ---------------- Nukkad Points ledger ---------------- */
const pointsSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true },
    reason: { type: String, required: true },
    // dedupe key so the same action never pays twice, e.g. "redeem:<claimId>"
    key: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);
export const PointsEntry = mongoose.model("PointsEntry", pointsSchema);

/* ---------------- Creators (local food bloggers / influencers) ---------------- */
const creatorSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    handle: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true },
    platform: { type: String, enum: ["instagram", "youtube", "facebook", "moj"], default: "instagram" },
    followers: { type: Number, default: 0 },
    niches: [String],
    area: String,
    city: { type: String, default: "bareilly", index: true },
    ratePerPost: { type: Number, default: 1000 },
    bio: String,
    emoji: { type: String, default: "📸" },
    completed: { type: Number, default: 0 },
  },
  { timestamps: true }
);
export const Creator = mongoose.model("Creator", creatorSchema);

const campaignSchema = new Schema(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    creator: { type: Schema.Types.ObjectId, ref: "Creator", required: true, index: true },
    brief: { type: String, required: true },
    budget: { type: Number, required: true },
    status: { type: String, enum: ["requested", "accepted", "declined", "posted", "completed"], default: "requested" },
    // each campaign gets its own deal so footfall from this creator is measurable
    deal: { type: Schema.Types.ObjectId, ref: "Deal" },
    postUrl: String,
  },
  { timestamps: true }
);
export const Campaign = mongoose.model("Campaign", campaignSchema);
