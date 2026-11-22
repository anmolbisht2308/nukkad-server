import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";

// GeoJSON point as a sub-schema, so optional locations stay absent until set
const point = new Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true }, // [lng, lat]
  },
  { _id: false }
);

/* ---------------- User ---------------- */
const userSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true },
    name: { type: String, trim: true, maxlength: 60 },
    role: { type: String, enum: ["user", "merchant", "organizer", "admin"], default: "user" },
    points: { type: Number, default: 0 },
    city: { type: String, default: "bareilly" },
    follows: [{ type: Schema.Types.ObjectId, ref: "Business" }],
  },
  { timestamps: true }
);
export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = mongoose.model("User", userSchema);

/* ---------------- OTP (auto-expires) ---------------- */
const otpSchema = new Schema({
  phone: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});
export const Otp = mongoose.model("Otp", otpSchema);

/* ---------------- Business ---------------- */
export const BUSINESS_KINDS = ["food_truck", "street_stall", "cafe", "restaurant", "bakery", "shop", "sports_venue"] as const;

const businessSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: BUSINESS_KINDS, required: true, index: true },
    city: { type: String, default: "bareilly", index: true },
    area: { type: String, required: true },
    address: String,
    tagline: String,
    description: String,
    tags: [String],
    priceLevel: { type: Number, min: 1, max: 3, default: 1 },
    emoji: { type: String, default: "🍽️" },
    photo: String, // "/uploads/<file>" served by the API
    theme: { from: { type: String, default: "#FF7A1A" }, to: { type: String, default: "#FF2E63" } },
    location: { type: point, required: true },
    phone: String,
    hours: String,
    owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
    verified: { type: Boolean, default: false },
    opening: {
      status: { type: String, enum: ["coming_soon", "open"], default: "open" },
      date: Date,
      notifyList: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], select: false },
      notifyCount: { type: Number, default: 0 },
      reminded: { type: Boolean, default: false }, // "opens tomorrow" alert sent
      announced: { type: Boolean, default: false }, // "open now" alert sent
    },
    // food trucks broadcast where they're parked today
    live: {
      isLive: { type: Boolean, default: false },
      spot: String,
      location: { type: point },
      until: Date,
      updatedAt: Date,
    },
    followersCount: { type: Number, default: 0 },
    rating: { avg: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  },
  { timestamps: true }
);
businessSchema.index({ location: "2dsphere" });
businessSchema.index({ name: "text", tagline: "text", tags: "text", area: "text" });
export type BusinessDoc = InferSchemaType<typeof businessSchema> & { _id: Types.ObjectId };
export const Business = mongoose.model("Business", businessSchema);

/* ---------------- Deal ---------------- */
const dealSchema = new Schema(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    title: { type: String, required: true },
    description: String,
    kind: { type: String, enum: ["first_n", "percent", "flat", "bogo", "freebie"], default: "percent" },
    value: { type: Number, default: 0 },
    limit: { type: Number, default: 100 },
    claimedCount: { type: Number, default: 0 },
    redeemedCount: { type: Number, default: 0 },
    startsAt: { type: Date, default: () => new Date() },
    endsAt: { type: Date, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
export const Deal = mongoose.model("Deal", dealSchema);

/* ---------------- Claim (a user's coupon) ---------------- */
const claimSchema = new Schema(
  {
    deal: { type: Schema.Types.ObjectId, ref: "Deal", required: true },
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    code: { type: String, required: true, unique: true },
    status: { type: String, enum: ["claimed", "redeemed"], default: "claimed" },
    redeemedAt: Date,
  },
  { timestamps: true }
);
claimSchema.index({ deal: 1, user: 1 }, { unique: true });
export const Claim = mongoose.model("Claim", claimSchema);

/* ---------------- Event ---------------- */
export const EVENT_KINDS = ["run_club", "cycling", "bike_ride", "food_fest", "night_market", "tournament", "trek", "meetup"] as const;

const eventSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    kind: { type: String, enum: EVENT_KINDS, required: true },
    city: { type: String, default: "bareilly", index: true },
    description: String,
    emoji: { type: String, default: "📍" },
    startsAt: { type: Date, required: true, index: true },
    endsAt: Date,
    venue: String,
    area: String,
    location: { type: point },
    organizer: String,
    price: { type: Number, default: 0 },
    capacity: { type: Number, default: 100 },
    attendees: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], select: false },
    rsvpCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
export const Event = mongoose.model("Event", eventSchema);

/* ---------------- Waitlist ---------------- */
const waitlistSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true },
    name: String,
    role: { type: String, enum: ["player", "foodie", "business", "venue", "organizer"], default: "foodie" },
    area: String,
    city: { type: String, default: "bareilly" },
  },
  { timestamps: true }
);
export const Waitlist = mongoose.model("Waitlist", waitlistSchema);
