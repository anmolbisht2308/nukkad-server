import { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { body, HttpError, notFound, parseQuery } from "../lib/http.js";
import { notify } from "../lib/notify.js";
import { createOrder, verifyPayment } from "../lib/payments.js";
import { award, POINTS } from "../lib/points.js";
import { optionalAuth, requireAuth, requireRole } from "../middleware/auth.js";
import { Business, Event } from "../models/index.js";
import { Match, Stall, Team, Tournament } from "../models/host.js";

/* Phase 3 "Host": tournaments & leagues (registration, fixtures, live scores,
   standings) and food-stall booking at events. Mounted at /api/host. */
const r = Router();

const ORGANISER_ROLES = ["organizer", "merchant", "admin"] as const;
const proofSchema = z.object({
  provider: z.enum(["mock", "razorpay"]),
  orderId: z.string(),
  paymentId: z.string().optional(),
  signature: z.string().optional(),
});

const slugify = (s: string) =>
  s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "tournament";

const SPORT_LOOK: Record<string, { emoji: string; from: string; to: string }> = {
  cricket: { emoji: "🏏", from: "#38B000", to: "#007200" },
  pickleball: { emoji: "🏓", from: "#00B4D8", to: "#0077B6" },
  football: { emoji: "⚽", from: "#4361EE", to: "#3A0CA3" },
  badminton: { emoji: "🏸", from: "#F72585", to: "#7209B7" },
  volleyball: { emoji: "🏐", from: "#FFB703", to: "#FB8500" },
  basketball: { emoji: "🏀", from: "#F77F00", to: "#D62828" },
};
export const sportLook = (sport: string) => SPORT_LOOK[sport.toLowerCase()] ?? { emoji: "🏆", from: "#FF7A1A", to: "#FF2E63" };

type TournamentLean = { _id: Types.ObjectId; organizer: Types.ObjectId; status: string; format: string; title: string; slug: string };

async function ownedTournament(slug: string, user: { id: string; role: string }) {
  const t = await Tournament.findOne({ slug: slug });
  if (!t) throw notFound("Tournament not found");
  if (user.role !== "admin" && String(t.organizer) !== user.id) throw new HttpError(403, "Only the organiser can do this");
  return t;
}

/* ---------------- standings (league) ---------------- */
type Row = { team: string; name: string; p: number; w: number; d: number; l: number; pf: number; pa: number; diff: number; pts: number };

function standings(teams: { _id: Types.ObjectId; name: string }[], matches: { teamA?: unknown; teamB?: unknown; scoreA?: number | null; scoreB?: number | null; status: string }[]): Row[] {
  const rows = new Map<string, Row>(teams.map((t) => [String(t._id), { team: String(t._id), name: t.name, p: 0, w: 0, d: 0, l: 0, pf: 0, pa: 0, diff: 0, pts: 0 }]));
  const idOf = (x: unknown) => (x && typeof x === "object" && "_id" in x ? String((x as { _id: unknown })._id) : x ? String(x) : "");
  for (const m of matches) {
    if (m.status !== "done" || m.scoreA == null || m.scoreB == null) continue;
    const a = rows.get(idOf(m.teamA));
    const b = rows.get(idOf(m.teamB));
    if (!a || !b) continue;
    a.p++; b.p++;
    a.pf += m.scoreA; a.pa += m.scoreB; b.pf += m.scoreB; b.pa += m.scoreA;
    if (m.scoreA > m.scoreB) { a.w++; b.l++; a.pts += 3; }
    else if (m.scoreA < m.scoreB) { b.w++; a.l++; b.pts += 3; }
    else { a.d++; b.d++; a.pts++; b.pts++; }
  }
  return [...rows.values()]
    .map((x) => ({ ...x, diff: x.pf - x.pa }))
    .sort((x, y) => y.pts - x.pts || y.diff - x.diff || y.pf - x.pf || x.name.localeCompare(y.name));
}

/* ---------------- fixtures ---------------- */
const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

export async function buildKnockout(t: { _id: Types.ObjectId; startsAt: Date }, teamIds: Types.ObjectId[]) {
  const size = nextPow2(teamIds.length);
  const rounds = Math.log2(size);
  const created: { _id: Types.ObjectId; round: number; order: number }[][] = [];
  // create every round's matches, latest round first so we can link nextMatch
  for (let round = rounds; round >= 1; round--) {
    const count = size / 2 ** round;
    const docs = await Match.insertMany(
      Array.from({ length: count }, (_, order) => {
        const next = round < rounds ? created[0][Math.floor(order / 2)] : undefined;
        return {
          tournament: t._id,
          round,
          order,
          startsAt: new Date(t.startsAt.getTime() + (round - 1) * 60 * 60_000),
          court: `Court ${(order % 2) + 1}`,
          nextMatch: next?._id,
          nextSlot: next ? (order % 2 === 0 ? "A" : "B") : undefined,
        };
      })
    );
    created.unshift(docs.map((d) => ({ _id: d._id, round, order: d.order })));
  }
  // round 1 in standard bracket order (1v8, 4v5, 2v7, 3v6 …): byes go to the top seeds,
  // and seeds 1 and 2 can only meet in the final. The lower seed index is always slot A.
  const order = (n: number): number[] => (n === 1 ? [0] : order(n / 2).flatMap((i) => [i, n - 1 - i]));
  const pos = order(size);
  for (let o = 0; o < size / 2; o++) {
    const a = teamIds[pos[2 * o]];
    const b = teamIds[pos[2 * o + 1]];
    const m = await Match.findById(created[0][o]._id);
    if (!m) continue;
    m.set({ teamA: a, teamB: b });
    if (a && !b) m.set({ bye: true, status: "done", winner: a });
    await m.save();
    if (a && !b) await advance(m._id);
  }
}

export async function buildLeague(t: { _id: Types.ObjectId; startsAt: Date }, teamIds: Types.ObjectId[]) {
  // circle method; null = bye
  const list: (Types.ObjectId | null)[] = [...teamIds];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const docs: Record<string, unknown>[] = [];
  for (let round = 1; round < n; round++) {
    let order = 0;
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (!a || !b) continue;
      docs.push({
        tournament: t._id,
        round,
        order: order++,
        teamA: round % 2 ? a : b, // alternate "home" side
        teamB: round % 2 ? b : a,
        startsAt: new Date(t.startsAt.getTime() + (round - 1) * 86_400_000 + i * 45 * 60_000),
        court: `Court ${(i % 2) + 1}`,
      });
    }
    list.splice(1, 0, list.pop()!); // rotate everyone but the first
  }
  await Match.insertMany(docs);
}

/** Push a finished knockout match's winner into its next match. */
export async function advance(matchId: Types.ObjectId) {
  const m = await Match.findById(matchId);
  if (!m?.nextMatch || !m.winner) return;
  const next = await Match.findById(m.nextMatch);
  if (!next) return;
  const slot = m.nextSlot === "A" ? "teamA" : "teamB";
  if (String(next.get(slot)) === String(m.winner)) return; // same winner as before: nothing to move
  if (next.status === "done" && !next.bye) throw new HttpError(409, "The next round is already played; edit that match first");
  next.set(slot, m.winner);
  await next.save();
}

async function completeIfFinished(tournamentId: Types.ObjectId) {
  const t = await Tournament.findById(tournamentId);
  if (!t || t.status === "completed") return;
  const matches = await Match.find({ tournament: t._id }).lean();
  if (!matches.length || matches.some((m) => m.status !== "done")) return;
  let champion: Types.ObjectId | undefined;
  if (t.format === "knockout") {
    const final = matches.find((m) => !m.nextMatch);
    champion = final?.winner ?? undefined;
  } else {
    const teams = await Team.find({ tournament: t._id, paid: true }, "name").lean();
    const [top, second] = standings(teams, matches);
    const deadLevel = !!second && top.pts === second.pts && top.diff === second.diff && top.pf === second.pf;
    // a full tie is left for the organiser to settle (play-off), not decided by team name
    champion = top && !deadLevel ? (teams.find((x) => String(x._id) === top.team)?._id ?? undefined) : undefined;
  }
  t.set({ status: "completed", champion });
  await t.save();
  const teams = await Team.find({ tournament: t._id, paid: true }, "captain name").lean();
  const champ = teams.find((x) => String(x._id) === String(champion));
  await notify(
    teams.map((x) => x.captain),
    { type: "tournament", emoji: "🏆", title: `${t.title} is over`, body: champ ? `${champ.name} are the champions!` : "Final results are in.", link: `/tournaments/${t.slug}` }
  );
}

/* ================= public ================= */

r.get("/tournaments", async (req, res) => {
  const q = parseQuery(z.object({ status: z.enum(["registration", "live", "completed"]).optional(), city: z.string().default("bareilly") }), req.query);
  const filter: Record<string, unknown> = { city: q.city };
  if (q.status) filter.status = q.status;
  const items = await Tournament.find(filter).sort({ status: 1, startsAt: 1 }).populate("venue", "slug name area").lean();
  res.json({ items });
});

r.get("/tournaments/:slug", optionalAuth, async (req, res) => {
  const t = await Tournament.findOne({ slug: req.params.slug }).populate("venue", "slug name area emoji").populate("organizer", "name").lean();
  if (!t) throw notFound("Tournament not found");
  const [teams, matches] = await Promise.all([
    Team.find({ tournament: t._id, paid: true }, "name players.name seed captain createdAt").sort({ seed: 1, createdAt: 1 }).lean(),
    Match.find({ tournament: t._id }).sort({ round: 1, order: 1 }).populate("teamA", "name").populate("teamB", "name").populate("winner", "name").lean(),
  ]);
  const publicTeams = teams.map(({ captain: _c, ...rest }) => rest);
  let myTeam: { _id: unknown; name: string; paid: boolean } | null = null;
  if (req.user) {
    const mine = await Team.findOne({ tournament: t._id, captain: req.user.id }, "name paid").lean();
    if (mine) myTeam = { _id: mine._id, name: mine.name, paid: mine.paid };
  }
  const rounds = matches.length ? Math.max(...matches.map((m) => m.round)) : 0;
  res.json({
    tournament: t,
    teams: publicTeams,
    matches,
    rounds,
    standings: t.format === "league" ? standings(teams, matches) : null,
    myTeam,
    isOrganizer: !!req.user && (req.user.role === "admin" || String((t.organizer as unknown as { _id: unknown })._id) === req.user.id),
  });
});

r.post(
  "/tournaments/:slug/register",
  requireAuth,
  body(
    z.object({
      teamName: z.string().trim().min(2).max(40),
      players: z.array(z.object({ name: z.string().trim().min(1).max(40), phone: z.string().trim().max(15).optional() })).min(1).max(20),
    })
  ),
  async (req, res) => {
    const t = await Tournament.findOne({ slug: req.params.slug });
    if (!t) throw notFound("Tournament not found");
    if (t.status !== "registration" || (await Match.exists({ tournament: t._id }))) throw new HttpError(409, "Registrations are closed");
    if (t.teamsCount >= t.maxTeams) throw new HttpError(409, "All team spots are taken");
    if (req.body.players.length < t.teamSize) throw new HttpError(400, `Add at least ${t.teamSize} players`);

    let team = await Team.findOne({ tournament: t._id, captain: req.user!.id });
    if (team?.paid) throw new HttpError(409, `You've already registered ${team.name}`);
    if (!team) team = new Team({ tournament: t._id, captain: req.user!.id, name: req.body.teamName, players: req.body.players });
    else team.set({ name: req.body.teamName, players: req.body.players });

    if (t.entryFee > 0) {
      const order = await createOrder(t.entryFee, `team_${team._id}`, { tournament: t.slug });
      team.set("payment", { orderId: order.orderId, provider: order.provider, status: "pending" });
      await team.save();
      res.status(201).json({ team: { _id: team._id, name: team.name, paid: false }, order });
      return;
    }
    // take a spot atomically so two captains signing up at once can't overfill it
    const spot = await Tournament.findOneAndUpdate(
      { _id: t._id, status: "registration", $expr: { $lt: ["$teamsCount", "$maxTeams"] } },
      { $inc: { teamsCount: 1 } },
      { returnDocument: "after" }
    );
    if (!spot) throw new HttpError(409, "All team spots are taken");
    team.set({ paid: true, seed: spot.teamsCount, payment: { status: "none" } });
    try {
      await team.save();
    } catch (e) {
      await Tournament.updateOne({ _id: t._id }, { $inc: { teamsCount: -1 } });
      throw e;
    }
    await award(req.user!.id, POINTS.tournament, `Registered ${team.name} for ${t.title}`, `tournament:${team._id}`);
    await notify([req.user!.id], { type: "tournament", emoji: t.emoji, title: `${team.name} is in!`, body: `You're registered for ${t.title}.`, link: `/tournaments/${t.slug}` });
    res.status(201).json({ team: { _id: team._id, name: team.name, paid: true } });
  }
);

r.post("/tournaments/:slug/teams/:id/confirm", requireAuth, body(z.object({ proof: proofSchema })), async (req, res) => {
  const t = await Tournament.findOne({ slug: req.params.slug });
  if (!t) throw notFound("Tournament not found");
  const team = await Team.findOne({ _id: req.params.id, tournament: t._id, captain: req.user!.id });
  if (!team) throw notFound("Team not found");
  if (team.paid) {
    res.json({ team: { _id: team._id, name: team.name, paid: true } });
    return;
  }
  const proof = req.body.proof;
  if (proof.orderId !== team.payment?.orderId || !verifyPayment(proof)) throw new HttpError(402, "Payment could not be verified");
  // claim this payment exactly once, so a double tap or retry can't take two spots
  const claimed = await Team.findOneAndUpdate(
    { _id: team._id, paid: false, "payment.orderId": proof.orderId, "payment.status": "pending" },
    { $set: { "payment.status": "processing" } }
  );
  if (!claimed) {
    const now = await Team.findById(team._id, "paid").lean();
    if (now?.paid) {
      res.json({ team: { _id: team._id, name: team.name, paid: true } });
      return;
    }
    throw new HttpError(409, "Your payment is already being processed");
  }
  // atomically take a spot so we never exceed maxTeams
  const closed = !!(await Match.exists({ tournament: t._id }));
  const spot = closed
    ? null
    : await Tournament.findOneAndUpdate(
        { _id: t._id, status: "registration", $expr: { $lt: ["$teamsCount", "$maxTeams"] } },
        { $inc: { teamsCount: 1 } },
        { returnDocument: "after" }
      );
  if (!spot) {
    await Team.updateOne({ _id: team._id }, { $set: { "payment.status": "refund_due" } });
    throw new HttpError(409, "Registrations closed before your payment finished. Contact the organiser for a refund.");
  }
  team.set({ paid: true, seed: spot.teamsCount, payment: { orderId: proof.orderId, provider: proof.provider, status: "paid" } });
  await team.save();
  await award(req.user!.id, POINTS.tournament, `Registered ${team.name} for ${t.title}`, `tournament:${team._id}`);
  await notify([req.user!.id], { type: "tournament", emoji: t.emoji, title: `${team.name} is in!`, body: `Entry fee paid for ${t.title}. See you on ${t.startsAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}.`, link: `/tournaments/${t.slug}` });
  await notify([t.organizer], { type: "tournament", emoji: "📝", title: `New team: ${team.name}`, body: `${spot.teamsCount}/${spot.maxTeams} teams in ${t.title}`, link: "/host" });
  res.json({ team: { _id: team._id, name: team.name, paid: true } });
});

r.get("/mine", requireAuth, async (req, res) => {
  const [organising, teams] = await Promise.all([
    Tournament.find(req.user!.role === "admin" ? {} : { organizer: req.user!.id }).sort({ startsAt: -1 }).lean(),
    Team.find({ captain: req.user!.id }).populate("tournament", "slug title emoji startsAt status format").lean(),
  ]);
  res.json({ organising, teams });
});

/* ================= organiser ================= */

r.post(
  "/tournaments",
  requireAuth,
  requireRole(...ORGANISER_ROLES),
  body(
    z.object({
      title: z.string().trim().min(3).max(80),
      sport: z.string().trim().min(2).max(30),
      format: z.enum(["knockout", "league"]),
      startsAt: z.coerce.date().refine((d) => d.getTime() > Date.now(), "Pick a start time in the future"),
      entryFee: z.number().min(0).max(100000).default(0),
      teamSize: z.number().int().min(1).max(15).default(6),
      maxTeams: z.number().int().min(2).max(64).default(8),
      prizes: z.array(z.string().trim().max(60)).max(5).default([]),
      rules: z.string().trim().max(1000).optional(),
      venueId: z.string().optional(),
      venueName: z.string().trim().max(80).optional(),
      area: z.string().trim().max(60).optional(),
    })
  ),
  async (req, res) => {
    const { venueId, ...b } = req.body;
    let venue: { _id: Types.ObjectId; name: string; area: string; city?: string | null } | null = null;
    if (venueId) {
      venue = await Business.findOne({ _id: venueId, kind: "sports_venue" }, "name area city").lean();
      if (!venue) throw new HttpError(400, "Venue not found");
    }
    const base = slugify(b.title);
    const look = sportLook(b.sport);
    const create = (slug: string) =>
      Tournament.create({
        ...b,
        sport: b.sport.toLowerCase(),
        slug,
        organizer: req.user!.id,
        venue: venue?._id,
        venueName: b.venueName ?? venue?.name,
        area: b.area ?? venue?.area,
        city: venue?.city ?? "bareilly",
        emoji: look.emoji,
        theme: { from: look.from, to: look.to },
      });
    // same title as another tournament (even one created this instant): add a short suffix and retry
    let t;
    for (let attempt = 0; ; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        t = await create(slug);
        break;
      } catch (e) {
        if ((e as { code?: number }).code !== 11000 || attempt >= 4) throw e;
      }
    }
    res.status(201).json({ tournament: t });
  }
);

r.post("/tournaments/:slug/fixtures", requireAuth, requireRole(...ORGANISER_ROLES), body(z.object({ shuffle: z.boolean().default(false) })), async (req, res) => {
  const t = await ownedTournament(String(req.params.slug), req.user!);
  if (t.status === "completed") throw new HttpError(409, "Tournament is already completed");
  if (await Match.exists({ tournament: t._id, status: { $ne: "scheduled" }, bye: { $ne: true } }))
    throw new HttpError(409, "Matches have already started; fixtures are locked");
  const teams = await Team.find({ tournament: t._id, paid: true }, "_id seed").sort({ seed: 1, createdAt: 1 }).lean();
  if (teams.length < 2) throw new HttpError(400, "Need at least 2 confirmed teams");
  const ids = teams.map((x) => x._id);
  if (req.body.shuffle) ids.sort(() => Math.random() - 0.5);
  await Match.deleteMany({ tournament: t._id });
  if (t.format === "knockout") await buildKnockout(t, ids);
  else await buildLeague(t, ids);
  const count = await Match.countDocuments({ tournament: t._id });
  res.json({ ok: true, matches: count });
});

r.post(
  "/matches/:id/score",
  requireAuth,
  requireRole(...ORGANISER_ROLES),
  body(z.object({ scoreA: z.number().int().min(0).max(9999), scoreB: z.number().int().min(0).max(9999), status: z.enum(["scheduled", "live", "done"]) })),
  async (req, res) => {
    const m = await Match.findById(req.params.id);
    if (!m) throw notFound("Match not found");
    const t = await Tournament.findById(m.tournament);
    if (!t) throw notFound("Tournament not found");
    if (req.user!.role !== "admin" && String(t.organizer) !== req.user!.id) throw new HttpError(403, "Only the organiser can do this");
    if (m.bye) throw new HttpError(409, "This is a bye");
    if (!m.teamA || !m.teamB) throw new HttpError(409, "Both teams aren't decided yet");
    const { scoreA, scoreB, status } = req.body;
    if (status === "done" && t.format === "knockout" && scoreA === scoreB) throw new HttpError(400, "Knockout matches need a winner (no draws)");

    const wasDone = m.status === "done";
    const winner = status === "done" ? (scoreA > scoreB ? m.teamA : scoreB > scoreA ? m.teamB : undefined) : undefined;
    if (t.format === "knockout" && m.nextMatch && wasDone && String(m.winner) !== String(winner)) {
      const next = await Match.findById(m.nextMatch);
      if (next && next.status !== "scheduled") throw new HttpError(409, "The next round has started; can't change this result");
    }
    m.set({ scoreA, scoreB, status, winner: winner ?? null });
    await m.save();
    // a corrected result after the end: reopen so the champion is worked out again below
    if (t.status === "completed") await Tournament.updateOne({ _id: t._id }, { $set: { status: "live" }, $unset: { champion: 1 } });

    if (t.status === "registration" && status !== "scheduled") await Tournament.updateOne({ _id: t._id }, { status: "live" });
    if (t.format === "knockout") {
      if (status === "done") await advance(m._id);
      else if (wasDone && m.nextMatch) {
        // result reopened: pull the old winner back out of the next match
        await Match.updateOne({ _id: m.nextMatch }, { $unset: { [m.nextSlot === "A" ? "teamA" : "teamB"]: 1 } });
      }
    }
    const teams = await Team.find({ _id: { $in: [m.teamA, m.teamB] } }, "name captain").lean();
    const name = (id: unknown) => teams.find((x) => String(x._id) === String(id))?.name ?? "TBD";
    if (status === "live" && !wasDone)
      await notify(teams.map((x) => x.captain), { type: "tournament", emoji: "🔴", title: `You're live: ${name(m.teamA)} vs ${name(m.teamB)}`, body: t.title, link: `/tournaments/${t.slug}` });
    if (status === "done" && !wasDone)
      await notify(teams.map((x) => x.captain), { type: "tournament", emoji: t.emoji, title: `${name(m.teamA)} ${scoreA} – ${scoreB} ${name(m.teamB)}`, body: winner ? `${name(winner)} win · ${t.title}` : `Draw · ${t.title}`, link: `/tournaments/${t.slug}` });
    await completeIfFinished(t._id);
    res.json({ match: m });
  }
);

r.post("/tournaments/:slug/status", requireAuth, requireRole(...ORGANISER_ROLES), body(z.object({ status: z.enum(["registration", "live", "completed"]) })), async (req, res) => {
  const t = await ownedTournament(String(req.params.slug), req.user!);
  const allowed: Record<string, string[]> = { registration: ["live"], live: ["registration", "completed"], completed: ["live"] };
  if (req.body.status !== t.status && !allowed[t.status]?.includes(req.body.status))
    throw new HttpError(409, `Can't move a tournament from ${t.status} to ${req.body.status}`);
  if (req.body.status === "registration" && (await Match.exists({ tournament: t._id, status: { $ne: "scheduled" }, bye: { $ne: true } })))
    throw new HttpError(409, "Matches have started; registrations can't reopen");
  if (req.body.status === "completed" && (await Match.exists({ tournament: t._id, status: { $ne: "done" } })))
    throw new HttpError(409, "Finish every match first; the tournament completes itself after the last result");
  t.set("status", req.body.status);
  await t.save();
  res.json({ tournament: t as unknown as TournamentLean });
});

/* ================= events & stalls ================= */

const releaseExpiredHolds = (eventId: Types.ObjectId) =>
  Stall.updateMany(
    { event: eventId, status: "held", heldUntil: { $lt: new Date() } },
    { $set: { status: "available", payment: { status: "none" } }, $unset: { business: 1, bookedBy: 1, heldUntil: 1 } }
  );

r.get("/events/:slug", optionalAuth, async (req, res) => {
  const e = await Event.findOne({ slug: req.params.slug }).lean();
  if (!e) throw notFound("Event not found");
  await releaseExpiredHolds(e._id);
  const stalls = await Stall.find({ event: e._id }, "status price").lean();
  const going = req.user ? !!(await Event.exists({ _id: e._id, attendees: req.user.id })) : false;
  const available = stalls.filter((s) => s.status === "available");
  res.json({
    event: e,
    going,
    stalls: stalls.length ? { total: stalls.length, available: available.length, minPrice: Math.min(...stalls.map((s) => s.price)) } : null,
  });
});

r.get("/events/:slug/stalls", async (req, res) => {
  const e = await Event.findOne({ slug: req.params.slug }, "_id").lean();
  if (!e) throw notFound("Event not found");
  await releaseExpiredHolds(e._id);
  const stalls = await Stall.find({ event: e._id }, "-payment -bookedBy").sort({ row: 1, col: 1 }).populate("business", "slug name emoji theme kind").lean();
  res.json({ stalls });
});

r.post(
  "/events/:slug/stalls",
  requireAuth,
  // Events have no owner account yet (organizer is a display name), so only Nukkad admins may lay out stalls.
  requireRole("admin"),
  body(z.object({ rows: z.number().int().min(1).max(8), cols: z.number().int().min(1).max(12), price: z.number().min(0).max(100000), size: z.enum(["small", "large"]).default("small") })),
  async (req, res) => {
    const e = await Event.findOne({ slug: req.params.slug }, "_id").lean();
    if (!e) throw notFound("Event not found");
    if (await Stall.exists({ event: e._id, status: { $ne: "available" } })) throw new HttpError(409, "Some stalls are already booked; the layout is locked");
    await Stall.deleteMany({ event: e._id });
    const { rows, cols, price, size } = req.body;
    const docs = [];
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < cols; col++)
        docs.push({ event: e._id, row, col, label: `${String.fromCharCode(65 + row)}${col + 1}`, price, size });
    await Stall.insertMany(docs);
    res.status(201).json({ ok: true, stalls: docs.length });
  }
);

r.post("/stalls/:id/book", requireAuth, requireRole("merchant", "admin"), body(z.object({ businessId: z.string() })), async (req, res) => {
  const biz = await Business.findOne(req.user!.role === "admin" ? { _id: req.body.businessId } : { _id: req.body.businessId, owner: req.user!.id }, "name").lean();
  if (!biz) throw new HttpError(403, "Pick one of your own businesses");
  const stall = await Stall.findById(req.params.id);
  if (!stall) throw notFound("Stall not found");
  await releaseExpiredHolds(stall.event as Types.ObjectId);
  const dupe = await Stall.findOne({ event: stall.event, business: biz._id, status: { $in: ["held", "booked"] } }, "label status").lean();
  if (dupe?.status === "booked") throw new HttpError(409, `${biz.name} already has stall ${dupe.label}`);
  const paid = stall.price > 0;
  const taken = await Stall.findOneAndUpdate(
    { _id: stall._id, status: "available" },
    { $set: { status: paid ? "held" : "booked", business: biz._id, bookedBy: req.user!.id, heldUntil: paid ? new Date(Date.now() + 10 * 60_000) : undefined } },
    { returnDocument: "after" }
  );
  if (!taken) throw new HttpError(409, "Someone just took this stall, pick another");
  // switching stalls: let go of the old hold only now that the new one is secured
  if (dupe && String(dupe._id) !== String(taken._id))
    await Stall.updateOne({ _id: dupe._id, status: "held" }, { $set: { status: "available", payment: { status: "none" } }, $unset: { business: 1, bookedBy: 1, heldUntil: 1 } });
  if (!paid) {
    res.json({ stall: taken });
    return;
  }
  const order = await createOrder(stall.price, `stall_${stall._id}`, { stall: stall.label });
  taken.set("payment", { orderId: order.orderId, provider: order.provider, status: "pending" });
  await taken.save();
  res.json({ stall: taken, order });
});

r.post("/stalls/:id/confirm", requireAuth, body(z.object({ proof: proofSchema })), async (req, res) => {
  const current = await Stall.findById(req.params.id);
  if (!current) throw notFound("Stall not found");
  if (String(current.bookedBy) !== req.user!.id) throw new HttpError(410, "Your hold expired, book the stall again");
  if (current.status === "booked") {
    res.json({ stall: current });
    return;
  }
  const proof = req.body.proof;
  if (proof.orderId !== current.payment?.orderId || !verifyPayment(proof)) throw new HttpError(402, "Payment could not be verified");
  // one conditional write: only succeeds if this user's hold on this order is still in place
  const stall = await Stall.findOneAndUpdate(
    { _id: current._id, bookedBy: req.user!.id, status: "held", "payment.orderId": proof.orderId },
    { $set: { status: "booked", payment: { orderId: proof.orderId, provider: proof.provider, status: "paid" } }, $unset: { heldUntil: 1 } },
    { returnDocument: "after" }
  );
  if (!stall) throw new HttpError(410, "Your hold expired, book the stall again");
  const e = await Event.findById(stall.event, "title slug").lean();
  await notify([req.user!.id], { type: "stall", emoji: "🚚", title: `Stall ${stall.label} is yours`, body: e?.title, link: e ? `/events/${e.slug}` : undefined });
  res.json({ stall });
});

export default r;
