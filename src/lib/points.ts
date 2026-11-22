import type { Types } from "mongoose";
import { User } from "../models/index.js";
import { PointsEntry } from "../models/social.js";
import { notify } from "./notify.js";

/* Nukkad Points: earned for real-world actions (verified redemptions, paid bookings,
   tournament entries, events). `key` makes every award idempotent. */
export const POINTS = {
  redeem: 10,
  booking_per_100: 5,
  rsvp: 5,
  tournament: 25,
  open_game: 10,
} as const;

export const tierFor = (points: number) =>
  points >= 1000 ? { name: "Legend", emoji: "👑", next: null } : points >= 400 ? { name: "Regular", emoji: "🔥", next: 1000 } : points >= 100 ? { name: "Local", emoji: "⭐", next: 400 } : { name: "Newbie", emoji: "🌱", next: 100 };

export async function award(user: string | Types.ObjectId, amount: number, reason: string, key?: string) {
  if (amount <= 0) return false;
  try {
    await PointsEntry.create({ user, amount: Math.round(amount), reason, key });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return false; // already awarded
    throw e;
  }
  await User.updateOne({ _id: user }, { $inc: { points: Math.round(amount) } });
  await notify([user], { type: "points", emoji: "🪙", title: `+${Math.round(amount)} Nukkad Points`, body: reason, link: "/me" });
  return true;
}
