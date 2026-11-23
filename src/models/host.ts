import mongoose, { Schema } from "mongoose";

/* Phase 3: tournaments & leagues, and food stalls at events. */

const paymentSub = new Schema(
  {
    orderId: String,
    provider: { type: String, enum: ["mock", "razorpay"] },
    status: { type: String, enum: ["none", "pending", "processing", "paid", "refund_due"], default: "none" },
  },
  { _id: false }
);

/* ---------------- Tournament ---------------- */
const tournamentSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true },
    sport: { type: String, required: true }, // cricket, pickleball, football, badminton…
    format: { type: String, enum: ["knockout", "league"], required: true },
    city: { type: String, default: "bareilly", index: true },
    venue: { type: Schema.Types.ObjectId, ref: "Business" },
    venueName: String,
    area: String,
    startsAt: { type: Date, required: true },
    entryFee: { type: Number, default: 0, min: 0 },
    teamSize: { type: Number, default: 6, min: 1 },
    maxTeams: { type: Number, default: 8, min: 2 },
    prizes: [String],
    rules: String,
    organizer: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["registration", "live", "completed"], default: "registration", index: true },
    emoji: { type: String, default: "🏆" },
    theme: { from: { type: String, default: "#FF7A1A" }, to: { type: String, default: "#FF2E63" } },
    teamsCount: { type: Number, default: 0 }, // paid / confirmed teams
    champion: { type: Schema.Types.ObjectId, ref: "Team" },
  },
  { timestamps: true }
);
export const Tournament = mongoose.model("Tournament", tournamentSchema);

/* ---------------- Team ---------------- */
const teamSchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: "Tournament", required: true, index: true },
    name: { type: String, required: true, trim: true },
    captain: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    players: [{ _id: false, name: { type: String, required: true }, phone: String }],
    paid: { type: Boolean, default: false },
    payment: { type: paymentSub, default: () => ({}) },
    seed: Number,
  },
  { timestamps: true }
);
teamSchema.index({ tournament: 1, name: 1 }, { unique: true });
export const Team = mongoose.model("Team", teamSchema);

/* ---------------- Match ---------------- */
const matchSchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: "Tournament", required: true, index: true },
    round: { type: Number, required: true }, // 1-based
    order: { type: Number, required: true }, // position within the round
    teamA: { type: Schema.Types.ObjectId, ref: "Team" },
    teamB: { type: Schema.Types.ObjectId, ref: "Team" },
    scoreA: Number,
    scoreB: Number,
    status: { type: String, enum: ["scheduled", "live", "done"], default: "scheduled" },
    winner: { type: Schema.Types.ObjectId, ref: "Team" },
    bye: { type: Boolean, default: false },
    startsAt: Date,
    court: String,
    // knockout: where the winner goes next
    nextMatch: { type: Schema.Types.ObjectId, ref: "Match" },
    nextSlot: { type: String, enum: ["A", "B"] },
  },
  { timestamps: true }
);
matchSchema.index({ tournament: 1, round: 1, order: 1 }, { unique: true });
export const Match = mongoose.model("Match", matchSchema);

/* ---------------- Stall (food trucks / stalls at an event) ---------------- */
const stallSchema = new Schema(
  {
    event: { type: Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    label: { type: String, required: true },
    row: { type: Number, required: true },
    col: { type: Number, required: true },
    size: { type: String, enum: ["small", "large"], default: "small" },
    price: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["available", "held", "booked"], default: "available" },
    business: { type: Schema.Types.ObjectId, ref: "Business" },
    bookedBy: { type: Schema.Types.ObjectId, ref: "User" },
    heldUntil: Date,
    payment: { type: paymentSub, default: () => ({}) },
  },
  { timestamps: true }
);
stallSchema.index({ event: 1, label: 1 }, { unique: true });
export const Stall = mongoose.model("Stall", stallSchema);
