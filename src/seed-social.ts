import type { Types } from "mongoose";
import { Business, Deal, User } from "./models/index.js";
import { Campaign, Creator, PointsEntry } from "./models/social.js";

/** Creators, campaigns, a second city and a points leaderboard. Called from seed.ts. All names are fictional. */
export async function seedSocial({ merchantId, userIds }: { merchantId: Types.ObjectId; userIds: Types.ObjectId[] }) {
  const creatorUsers = await User.insertMany(
    [
      ["Bareilly Bites", "9820000001"],
      ["Chatori Diaries", "9820000002"],
      ["Run With Riya", "9820000003"],
      ["Two Wheels UP25", "9820000004"],
      ["Desi Dessert Hunt", "9820000005"],
    ].map(([name, phone]) => ({ name, phone }))
  );
  const creators = await Creator.insertMany([
    { user: creatorUsers[0]._id, handle: "bareillybites", name: "Bareilly Bites", followers: 48200, niches: ["food", "street food"], area: "Civil Lines", ratePerPost: 2500, emoji: "🍢", completed: 23, bio: "Eating my way through every gali in Bareilly. Honest reviews, no paid hype." },
    { user: creatorUsers[1]._id, handle: "chatori.diaries", name: "Chatori Diaries", followers: 21500, niches: ["food", "cafes"], area: "Model Town", ratePerPost: 1500, emoji: "☕", completed: 11, bio: "Café hopping, chai stops and weekend brunches." },
    { user: creatorUsers[2]._id, handle: "runwithriya", name: "Run With Riya", platform: "instagram", followers: 9800, niches: ["fitness", "running"], area: "Gandhi Udyan", ratePerPost: 800, emoji: "🏃‍♀️", completed: 6, bio: "Sunday long runs, protein bowls and finish-line selfies." },
    { user: creatorUsers[3]._id, handle: "twowheels.up25", name: "Two Wheels UP25", platform: "youtube", followers: 35700, niches: ["rides", "travel"], area: "Izzatnagar", ratePerPost: 3000, emoji: "🏍️", completed: 14, bio: "Night rides, highway dhabas and weekend getaways from Bareilly." },
    { user: creatorUsers[4]._id, handle: "dessert.hunt", name: "Desi Dessert Hunt", followers: 14300, niches: ["food", "desserts"], area: "Prem Nagar", ratePerPost: 1200, emoji: "🍨", completed: 9, bio: "Kulfi, rabri, waffles: if it's sweet, I'm there." },
  ]);

  const biz = Object.fromEntries((await Business.find({ owner: merchantId }, "slug").lean()).map((b) => [b.slug, b._id]));
  if (biz["bareilly-burger-garage"]) {
    const d1 = await Deal.create({ business: biz["bareilly-burger-garage"], title: "@bareillybites special: 15% off", description: "Seen on @bareillybites? Claim for 15% off.", kind: "percent", value: 15, limit: 200, claimedCount: 96, redeemedCount: 71, endsAt: new Date(Date.now() + 10 * 86_400_000) });
    await Campaign.create({ business: biz["bareilly-burger-garage"], creator: creators[0]._id, brief: "Launch reel for our smash burgers, shot at the truck on a weekend night.", budget: 2500, status: "completed", deal: d1._id, postUrl: "https://instagram.com/p/demo" });
  }
  if (biz["desi-waffle-co"]) {
    const d2 = await Deal.create({ business: biz["desi-waffle-co"], title: "@dessert.hunt special: 15% off", kind: "percent", value: 15, limit: 200, active: false, endsAt: new Date(Date.now() + 21 * 86_400_000) });
    await Campaign.create({ business: biz["desi-waffle-co"], creator: creators[4]._id, brief: "Pre-opening teaser: try the gulab-jamun waffle before anyone else and post a reel.", budget: 1200, status: "requested", deal: d2._id });
  }

  // Moradabad: launching city with a handful of listings
  await Business.insertMany(
    [
      { slug: "brass-city-chaat-truck", name: "Brass City Chaat Truck", kind: "food_truck", area: "Civil Lines, Moradabad", tagline: "Tikki, gol gappe & dahi bhalle", emoji: "🥙", theme: { from: "#F9C74F", to: "#F3722C" }, c: [78.776, 28.84], live: true },
      { slug: "ramganga-rolls", name: "Ramganga Rolls", kind: "food_truck", area: "Kanth Road, Moradabad", tagline: "Kathi rolls by the river road", emoji: "🌯", theme: { from: "#43AA8B", to: "#277DA1" }, c: [78.79, 28.83], live: false },
      { slug: "peetal-nagri-cafe", name: "Peetal Nagri Café", kind: "cafe", area: "Buddhi Vihar, Moradabad", tagline: "Cold coffee in brass tumblers", emoji: "🧋", theme: { from: "#B08968", to: "#7F5539" }, c: [78.76, 28.85], live: false },
    ].map(({ c, live, ...b }) => ({
      ...b,
      city: "moradabad",
      address: b.area,
      description: b.tagline,
      tags: ["moradabad"],
      location: { type: "Point", coordinates: c },
      owner: merchantId,
      opening: { status: "open", date: new Date(Date.now() - 30 * 86_400_000) },
      live: live ? { isLive: true, spot: "Near the clock tower", location: { type: "Point", coordinates: c }, until: new Date(Date.now() + 4 * 3_600_000), updatedAt: new Date() } : { isLive: false },
    }))
  );

  // points leaderboard
  const amounts = [640, 410, 380, 220, 150, 95, 60, 25];
  for (let i = 0; i < userIds.length; i++) {
    const amt = amounts[i % amounts.length];
    await PointsEntry.create({ user: userIds[i], amount: amt, reason: "Early member bonus" });
    await User.updateOne({ _id: userIds[i] }, { $set: { points: amt } });
  }
}
