import type { Types } from "mongoose";
import { Business, Event } from "./models/index.js";
import { Match, Stall, Team, Tournament } from "./models/host.js";
import { advance, buildKnockout, buildLeague, sportLook } from "./routes/host.js";

/** Phase 3 demo data (tournaments, teams, matches, event stalls). Called from seed.ts. */
export async function seedHost({ merchantId, organizerId, userIds }: { merchantId: Types.ObjectId; organizerId: Types.ObjectId; userIds: Types.ObjectId[] }) {
  const [boxHub, smash] = await Promise.all([
    Business.findOne({ slug: "box-cricket-hub" }, "_id name area").lean(),
    Business.findOne({ slug: "smash-point-pickleball" }, "_id name area").lean(),
  ]);
  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);
  const NAMES = ["Arjun", "Sameer", "Kunal", "Faizan", "Dev", "Harsh", "Imran", "Nikhil", "Pranav", "Rahul", "Siddharth", "Tanmay", "Yash", "Zaid", "Ankit", "Varun", "Aditya", "Gaurav", "Mohit", "Sahil"];
  const squad = (n: number, offset: number) => Array.from({ length: n }, (_, i) => ({ name: NAMES[(offset + i) % NAMES.length] }));

  const make = async (t: {
    slug: string; title: string; sport: string; format: "knockout" | "league"; venue?: { _id: Types.ObjectId; name: string; area: string } | null;
    startsAt: Date; entryFee: number; teamSize: number; maxTeams: number; prizes: string[]; rules: string; status: "registration" | "live";
  }, teamNames: string[]) => {
    const look = sportLook(t.sport);
    const doc = await Tournament.create({
      ...t, venue: t.venue?._id, venueName: t.venue?.name, area: t.venue?.area, organizer: organizerId,
      emoji: look.emoji, theme: { from: look.from, to: look.to }, teamsCount: teamNames.length,
    });
    const teams = await Team.insertMany(
      teamNames.map((name, i) => ({
        tournament: doc._id, name, captain: userIds[i % userIds.length], players: squad(t.teamSize, i * 3), paid: true, seed: i + 1,
        payment: { status: t.entryFee ? "paid" : "none", provider: "mock", orderId: `mock_seed_${i}` },
      }))
    );
    return { doc, teamIds: teams.map((x) => x._id) };
  };

  /* Knockout: 8 teams, round 1 half played, one live */
  const cup = await make(
    {
      slug: "bareilly-box-cricket-cup", title: "Bareilly Box Cricket Cup", sport: "cricket", format: "knockout", venue: boxHub,
      startsAt: hoursFromNow(-2), entryFee: 1200, teamSize: 6, maxTeams: 8, status: "live",
      prizes: ["₹15,000 + trophy", "₹5,000 runners-up", "Player of the tournament: ₹2,000"],
      rules: "6-a-side, 6 overs per innings. Tennis ball. One bowler max 2 overs. Ties settled by a super over.",
    },
    ["DD Puram Daredevils", "Civil Lines Strikers", "Izzatnagar Express", "Model Town Mavericks", "Rajendra Nagar Royals", "Prem Nagar Panthers", "Kutubkhana Kings", "Green Park Gladiators"]
  );
  await buildKnockout(cup.doc, cup.teamIds);
  const r1 = await Match.find({ tournament: cup.doc._id, round: 1 }).sort({ order: 1 });
  const results: [number, number][] = [[64, 58], [71, 70]];
  for (let i = 0; i < 2; i++) {
    const [a, b] = results[i];
    r1[i].set({ scoreA: a, scoreB: b, status: "done", winner: a > b ? r1[i].teamA : r1[i].teamB });
    await r1[i].save();
    await advance(r1[i]._id);
  }
  r1[2].set({ scoreA: 38, scoreB: 29, status: "live" });
  await r1[2].save();

  /* League: 5 doubles teams, a few results in */
  const league = await make(
    {
      slug: "pickleball-doubles-league", title: "Pickleball Doubles League", sport: "pickleball", format: "league", venue: smash,
      startsAt: hoursFromNow(-48), entryFee: 800, teamSize: 2, maxTeams: 6, status: "live",
      prizes: ["₹8,000 + premium paddles", "₹3,000 runners-up"],
      rules: "Doubles, games to 11 (win by 2). Win = 3 pts, draw = 1. Ties broken by point difference.",
    },
    ["Dink Dynasty", "Kitchen Kings", "Net Ninjas", "Smash Sisters", "Paddle Pirates"]
  );
  await buildLeague(league.doc, league.teamIds);
  const lm = await Match.find({ tournament: league.doc._id }).sort({ round: 1, order: 1 });
  const scores: [number, number][] = [[11, 7], [9, 11], [11, 4], [11, 13]];
  for (let i = 0; i < scores.length && i < lm.length; i++) {
    const [a, b] = scores[i];
    lm[i].set({ scoreA: a, scoreB: b, status: "done", winner: a > b ? lm[i].teamA : lm[i].teamB });
    await lm[i].save();
  }
  if (lm[scores.length]) {
    lm[scores.length].set({ scoreA: 6, scoreB: 5, status: "live" });
    await lm[scores.length].save();
  }

  /* Registration open */
  await make(
    {
      slug: "sunday-football-7s", title: "Sunday Football 7s", sport: "football", format: "knockout", venue: null,
      startsAt: hoursFromNow(24 * 9), entryFee: 1400, teamSize: 7, maxTeams: 12, status: "registration",
      prizes: ["₹20,000 + trophy", "₹7,000 runners-up", "Golden boot: ₹1,500"],
      rules: "7-a-side, 2 × 15 min halves, rolling subs. Studs allowed on turf. Draws go to penalties in knockouts.",
    },
    ["Bareilly Ballers", "Ramganga FC", "Jhumka United"]
  );
  await Tournament.updateOne({ slug: "sunday-football-7s" }, { venueName: "Railway Ground, Izzatnagar", area: "Izzatnagar" });

  /* Stalls at Food Truck Friday */
  const ftf = await Event.findOne({ slug: "food-truck-friday" }, "_id").lean();
  if (ftf) {
    const docs = [];
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 6; col++)
        docs.push({ event: ftf._id, row, col, label: `${String.fromCharCode(65 + row)}${col + 1}`, price: col === 0 || col === 5 ? 2000 : 1500, size: col === 0 || col === 5 ? "large" : "small" });
    await Stall.insertMany(docs);
    const trucks = await Business.find({ slug: { $in: ["momo-bros-truck", "tandoori-tales-on-wheels", "bareilly-burger-garage", "surma-street-rolls"] } }, "_id slug").lean();
    const at: Record<string, string> = { "momo-bros-truck": "A1", "tandoori-tales-on-wheels": "A3", "bareilly-burger-garage": "B2", "surma-street-rolls": "B6" };
    for (const t of trucks)
      await Stall.updateOne(
        { event: ftf._id, label: at[t.slug] },
        { status: "booked", business: t._id, bookedBy: merchantId, payment: { status: "paid", provider: "mock", orderId: `mock_seed_${t.slug}` } }
      );
  }
}
