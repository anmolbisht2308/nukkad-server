import type { Types } from "mongoose";
import { Notification } from "../models/social.js";

type Id = string | Types.ObjectId;
export type NotifyInput = { type: string; title: string; body?: string; link?: string; emoji?: string };

/** Store an in-app notification for each user. Push / WhatsApp delivery plugs in here later. */
export async function notify(users: Id[], n: NotifyInput) {
  const unique = [...new Set(users.map(String))];
  if (!unique.length) return 0;
  await Notification.insertMany(unique.map((user) => ({ user, ...n })));
  // TODO: fan out to WhatsApp (Gupshup / Meta Cloud API) and web push for users who opted in.
  return unique.length;
}
