import mongoose, { Schema } from "mongoose";

export const SPORTS = ["cricket", "football", "pickleball", "badminton", "tennis", "basketball"] as const;

/* ---------------- Court (a bookable unit inside a sports venue) ---------------- */
const courtSchema = new Schema(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    name: { type: String, required: true, trim: true },
    sport: { type: String, enum: SPORTS, required: true },
    pricePerHour: { type: Number, required: true, min: 0 },
    peakPricePerHour: { type: Number, required: true, min: 0 },
    peakFrom: { type: Number, default: 18, min: 0, max: 24 },
    peakTo: { type: Number, default: 22, min: 0, max: 24 },
    openHour: { type: Number, default: 6, min: 0, max: 23 },
    closeHour: { type: Number, default: 23, min: 1, max: 24 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
export const Court = mongoose.model("Court", courtSchema);

/* ---------------- Booking ---------------- */
const participantSchema = new Schema(
  {
    name: { type: String, required: true },
    phone: String,
    share: { type: Number, default: 0 },
    paid: { type: Boolean, default: false },
    user: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false }
);

const bookingSchema = new Schema(
  {
    court: { type: Schema.Types.ObjectId, ref: "Court", required: true, index: true },
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", index: true },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD in IST
    startHour: { type: Number, required: true, min: 0, max: 23 },
    hours: { type: Number, required: true, min: 1, max: 4 },
    amount: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "confirmed", "cancelled", "completed", "no_show"], default: "pending", index: true },
    source: { type: String, enum: ["app", "walkin", "blocked"], default: "app" },
    note: String,
    payment: {
      mode: { type: String, enum: ["online", "venue"], default: "venue" },
      status: { type: String, enum: ["unpaid", "paid", "refund_due"], default: "unpaid" },
      orderId: String,
      provider: String,
    },
    participants: [participantSchema],
    game: { type: Schema.Types.ObjectId, ref: "OpenGame" },
  },
  { timestamps: true }
);
export const Booking = mongoose.model("Booking", bookingSchema);

/* ---------------- SlotLock: one row per court-hour; the unique index makes double booking impossible ---------------- */
const slotLockSchema = new Schema({
  court: { type: Schema.Types.ObjectId, ref: "Court", required: true },
  date: { type: String, required: true },
  hour: { type: Number, required: true },
  booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
});
slotLockSchema.index({ court: 1, date: 1, hour: 1 }, { unique: true });
export const SlotLock = mongoose.model("SlotLock", slotLockSchema);

/* ---------------- Open game: a booking that needs more players ---------------- */
const openGameSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true, unique: true },
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    court: { type: Schema.Types.ObjectId, ref: "Court", required: true },
    host: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sport: { type: String, enum: SPORTS, required: true },
    skill: { type: String, enum: ["beginner", "intermediate", "advanced", "any"], default: "any" },
    spots: { type: Number, required: true, min: 1, max: 20 },
    pricePerHead: { type: Number, default: 0, min: 0 },
    players: [{ type: Schema.Types.ObjectId, ref: "User" }],
    note: String,
    status: { type: String, enum: ["open", "full", "cancelled"], default: "open", index: true },
    startsAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);
export const OpenGame = mongoose.model("OpenGame", openGameSchema);
