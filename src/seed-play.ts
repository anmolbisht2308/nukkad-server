import type { Types } from "mongoose";
import { Business } from "./models/index.js";
import { Booking, Court, OpenGame, SlotLock, SPORTS } from "./models/play.js";
import { istToday, priceForRange, slotStart } from "./routes/play.js";

/** Phase 2 demo data (venues, courts, bookings, open games). Called from seed.ts. */
export async function seedPlay({ merchantId, userIds }: { merchantId: Types.ObjectId; userIds: Types.ObjectId[] }) {
  const pt = (lng: number, lat: number) => ({ type: "Point" as const, coordinates: [lng, lat] });

  // two more venues alongside the seeded Smash Point and Box Cricket Hub
  await Business.insertMany([
    {
      slug: "kickoff-arena", name: "Kickoff Arena", kind: "sports_venue", area: "Pilibhit Bypass", address: "Pilibhit Bypass, Bareilly",
      tagline: "FIFA-grade turf for 5s and 7s", description: "Two floodlit football turfs with changing rooms, drinking water and a small café. Bring your squad or join an open game.",
      tags: ["football", "turf", "5-a-side"], emoji: "⚽", theme: { from: "#2B9348", to: "#004B23" }, priceLevel: 2, hours: "6 AM – 12 AM",
      location: pt(79.4572, 28.3866), owner: merchantId, verified: true, opening: { status: "open", date: new Date(Date.now() - 90 * 86_400_000) },
      followersCount: 512, rating: { avg: 4.6, count: 143 },
    },
    {
      slug: "shuttle-house", name: "Shuttle House", kind: "sports_venue", area: "Rajendra Nagar", address: "Rajendra Nagar, Bareilly",
      tagline: "Wooden-floor badminton, AC hall", description: "Three wooden badminton courts in an air-conditioned hall, with racket rental and evening coaching.",
      tags: ["badminton", "indoor", "AC"], emoji: "🏸", theme: { from: "#7209B7", to: "#3A0CA3" }, priceLevel: 2, hours: "6 AM – 11 PM",
      location: pt(79.4426, 28.3751), owner: merchantId, verified: true, opening: { status: "open", date: new Date(Date.now() - 200 * 86_400_000) },
      followersCount: 276, rating: { avg: 4.5, count: 88 },
    },
  ]);

  const venues = await Business.find({ slug: { $in: ["smash-point-pickleball", "box-cricket-hub", "kickoff-arena", "shuttle-house"] } }, "_id slug").lean();
  const v = Object.fromEntries(venues.map((b) => [b.slug, b._id]));

  const spec = [
    ...[1, 2, 3, 4].map((n) => ({ business: v["smash-point-pickleball"], name: `Court ${n}`, sport: "pickleball", pricePerHour: 400, peakPricePerHour: 600, peakFrom: 17, peakTo: 22, openHour: 6, closeHour: 23 })),
    ...["Arena A", "Arena B"].map((name) => ({ business: v["box-cricket-hub"], name, sport: "cricket", pricePerHour: 1000, peakPricePerHour: 1400, peakFrom: 18, peakTo: 23, openHour: 6, closeHour: 24 })),
    { business: v["kickoff-arena"], name: "Turf 5s", sport: "football", pricePerHour: 1200, peakPricePerHour: 1600, peakFrom: 18, peakTo: 23, openHour: 6, closeHour: 24 },
    { business: v["kickoff-arena"], name: "Turf 7s", sport: "football", pricePerHour: 1800, peakPricePerHour: 2400, peakFrom: 18, peakTo: 23, openHour: 6, closeHour: 24 },
    ...[1, 2, 3].map((n) => ({ business: v["shuttle-house"], name: `Court ${n}`, sport: "badminton", pricePerHour: 300, peakPricePerHour: 450, peakFrom: 17, peakTo: 21, openHour: 6, closeHour: 23 })),
  ];
  const courts = await Court.insertMany(spec);
  const byName = (slug: string, name: string) => courts.find((c) => String(c.business) === String(v[slug]) && c.name === name)!;

  // confirmed bookings today and tomorrow, each with its slot locks
  const today = istToday();
  const tomorrow = istToday(1);
  const plan: { court: ReturnType<typeof byName>; date: string; start: number; hours: number; who: number; mode: "online" | "venue"; source?: "app" | "walkin" }[] = [
    { court: byName("box-cricket-hub", "Arena A"), date: today, start: 19, hours: 2, who: 0, mode: "online" },
    { court: byName("box-cricket-hub", "Arena A"), date: today, start: 21, hours: 1, who: 1, mode: "venue", source: "walkin" },
    { court: byName("box-cricket-hub", "Arena B"), date: today, start: 20, hours: 2, who: 2, mode: "venue" },
    { court: byName("smash-point-pickleball", "Court 1"), date: today, start: 18, hours: 1, who: 3, mode: "online" },
    { court: byName("smash-point-pickleball", "Court 2"), date: today, start: 19, hours: 2, who: 4, mode: "venue" },
    { court: byName("kickoff-arena", "Turf 5s"), date: today, start: 20, hours: 1, who: 5, mode: "online" },
    { court: byName("kickoff-arena", "Turf 7s"), date: tomorrow, start: 19, hours: 2, who: 6, mode: "online" },
    { court: byName("shuttle-house", "Court 1"), date: tomorrow, start: 7, hours: 1, who: 7, mode: "venue" },
    { court: byName("box-cricket-hub", "Arena B"), date: tomorrow, start: 21, hours: 2, who: 0, mode: "online" },
    { court: byName("smash-point-pickleball", "Court 3"), date: tomorrow, start: 18, hours: 2, who: 1, mode: "online" },
  ];
  const names = ["Aarav", "Ishita", "Kabir", "Zoya", "Rohan", "Meera", "Vivaan", "Anaya"];
  const bookings = [];
  for (const p of plan) {
    const amount = priceForRange(p.court, p.start, p.hours);
    const walkin = p.source === "walkin";
    const b = await Booking.create({
      court: p.court._id, business: p.court.business, user: walkin ? undefined : userIds[p.who], date: p.date, startHour: p.start, hours: p.hours, amount,
      status: "confirmed", source: p.source ?? "app",
      payment: { mode: p.mode, status: p.mode === "online" ? "paid" : "unpaid", provider: p.mode === "online" ? "mock" : undefined },
      participants: [{ name: names[p.who], phone: `98100000${String(p.who).padStart(2, "0")}`, share: amount, paid: p.mode === "online", user: walkin ? undefined : userIds[p.who] }],
    });
    await SlotLock.insertMany(Array.from({ length: p.hours }, (_, i) => ({ court: p.court._id, date: p.date, hour: p.start + i, booking: b._id })));
    bookings.push(b);
  }

  // open games on future bookings
  type Skill = "beginner" | "intermediate" | "advanced" | "any";
  const games: { b: (typeof bookings)[number]; spots: number; price: number; skill: Skill; note: string; players: Types.ObjectId[] }[] = [
    { b: bookings[6], spots: 6, price: 200, skill: "intermediate", note: "7-a-side, need 6 more. Bibs provided.", players: [userIds[1], userIds[2]] },
    { b: bookings[9], spots: 2, price: 250, skill: "beginner", note: "Doubles, chill game, first-timers welcome!", players: [] },
    { b: bookings[8], spots: 4, price: 300, skill: "any", note: "Box cricket, 6 per side. Tennis ball.", players: [userIds[5]] },
  ];
  for (const g of games) {
    const court = courts.find((c) => String(c._id) === String(g.b.court))!;
    const game = await OpenGame.create({
      booking: g.b._id, business: g.b.business, court: court._id, host: g.b.user!, sport: court.sport as (typeof SPORTS)[number], skill: g.skill,
      spots: g.spots, pricePerHead: g.price, note: g.note, players: g.players, startsAt: slotStart(g.b.date, g.b.startHour),
    });
    g.b.game = game._id;
    await g.b.save();
  }
}
