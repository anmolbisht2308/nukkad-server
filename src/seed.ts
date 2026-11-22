/* Demo data for Bareilly. All businesses are fictional; areas and coordinates are approximate.
   Run: npm run seed  (wipes and refills the database) */
import mongoose from "mongoose";
import { config } from "./config.js";
import { Business, Claim, Deal, Event, Otp, User, Waitlist } from "./models/index.js";
import { seedPlay } from "./seed-play.js";
import { seedHost } from "./seed-host.js";
import { seedSocial } from "./seed-social.js";

const A = {
  civilLines: { area: "Civil Lines", c: [79.4205, 28.3592] },
  rajendraNagar: { area: "Rajendra Nagar", c: [79.4418, 28.3745] },
  ddPuram: { area: "DD Puram", c: [79.4302, 28.3702] },
  premNagar: { area: "Prem Nagar", c: [79.4188, 28.3731] },
  pilibhitBypass: { area: "Pilibhit Bypass", c: [79.4561, 28.3856] },
  modelTown: { area: "Model Town", c: [79.4395, 28.3801] },
  greenPark: { area: "Green Park", c: [79.4336, 28.3884] },
  kutubkhana: { area: "Kutubkhana", c: [79.4151, 28.3643] },
  izzatnagar: { area: "Izzatnagar", c: [79.4203, 28.3962] },
  gandhiUdyan: { area: "Gandhi Udyan", c: [79.4262, 28.3626] },
} as const;

const pt = (c: readonly number[]) => ({ type: "Point" as const, coordinates: [c[0], c[1]] });
const hrs = (h: number) => new Date(Date.now() + h * 3_600_000);
const days = (d: number) => new Date(Date.now() + d * 86_400_000);
/** next given weekday (0=Sun) at hour:min IST */
const nextDow = (dow: number, h: number, m = 0) => {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60_000);
  let add = (dow - ist.getUTCDay() + 7) % 7;
  const t = () => new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add, h, m) - 330 * 60_000);
  if (t() < now) add += 7;
  return t();
};
/** n days from today at h:00 IST — openings happen at sensible hours */
const dayAt = (n: number, h: number) => {
  const ist = new Date(Date.now() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + n, h) - 330 * 60_000);
};
const todayAt = (h: number, m = 0) => {
  const ist = new Date(Date.now() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - 330 * 60_000);
};

await mongoose.connect(config.mongoUri);
await mongoose.connection.dropDatabase();

const merchant = await User.create({ phone: "9999999999", name: "Demo Merchant", role: "merchant" });
await User.create({ phone: "9000000001", name: "Admin", role: "admin" });
const organizer = await User.create({ phone: "9888888888", name: "Demo Organiser", role: "organizer" });
// a few players so feeds, games and teams look alive
const players = await User.insertMany(
  ["Aarav", "Ishita", "Kabir", "Zoya", "Rohan", "Meera", "Vivaan", "Anaya"].map((name, i) => ({ phone: `98100000${String(i).padStart(2, "0")}`, name }))
);
const userIds = players.map((p) => p._id);

type Seed = {
  slug: string; name: string; kind: string; at: keyof typeof A; tagline: string; description: string;
  tags: string[]; emoji: string; theme: [string, string]; price?: number; hours?: string;
  opening?: { status: "open" | "coming_soon"; date: Date };
  live?: { spot: string; at: keyof typeof A; untilH: number };
  followers?: number; rating?: [number, number];
};

const seeds: Seed[] = [
  { slug: "momo-bros-truck", name: "Momo Bros Truck", kind: "food_truck", at: "civilLines", tagline: "Tandoori, fried & jhol momos, hot off the truck", description: "Two brothers, one bright yellow truck and twelve kinds of momos. The jhol momo is the reason people queue.", tags: ["momos", "tibetan", "spicy"], emoji: "🥟", theme: ["#FFB703", "#FB5607"], followers: 842, rating: [4.6, 312], live: { spot: "Near Civil Lines market gate", at: "civilLines", untilH: 4 }, opening: { status: "open", date: days(-200) } },
  { slug: "tandoori-tales-on-wheels", name: "Tandoori Tales on Wheels", kind: "food_truck", at: "pilibhitBypass", tagline: "Charcoal tikka rolls & malai chaap", description: "A charcoal tandoor bolted to a truck. Paneer tikka rolls, malai chaap and the city's smokiest chicken seekh.", tags: ["rolls", "tandoori", "chaap"], emoji: "🔥", theme: ["#E63946", "#9D0208"], followers: 1210, rating: [4.7, 540], live: { spot: "Pilibhit Bypass, opposite the petrol pump", at: "pilibhitBypass", untilH: 5 }, opening: { status: "open", date: days(-420) } },
  { slug: "bareilly-burger-garage", name: "Bareilly Burger Garage", kind: "food_truck", at: "rajendraNagar", tagline: "Smash burgers & loaded fries", description: "Smashed patties, potato buns and fries loaded with cheese sauce and jalapeños. Opened three weeks ago and already a Rajendra Nagar favourite.", tags: ["burgers", "fries", "american"], emoji: "🍔", theme: ["#F77F00", "#D62828"], followers: 389, rating: [4.5, 96], live: { spot: "Rajendra Nagar main road, by the park", at: "rajendraNagar", untilH: 3 }, opening: { status: "open", date: days(-12) } },
  { slug: "surma-street-rolls", name: "Surma Street Rolls", kind: "food_truck", at: "ddPuram", tagline: "Kathi rolls with Bareilly swag", description: "Egg, paneer and chicken kathi rolls with house green chutney. Parks somewhere new every night, so follow to know where.", tags: ["rolls", "kathi", "late night"], emoji: "🌯", theme: ["#06D6A0", "#118AB2"], followers: 274, rating: [4.3, 88], opening: { status: "open", date: days(-90) } },
  { slug: "the-chai-cart-co", name: "The Chai Cart Co.", kind: "street_stall", at: "gandhiUdyan", tagline: "Kulhad chai, bun maska, good conversations", description: "Twelve chais in clay kulhads: masala, gur, tandoori and a saffron special. Right by Gandhi Udyan's morning walkers.", tags: ["chai", "kulhad", "breakfast"], emoji: "🫖", theme: ["#BC6C25", "#7F4F24"], followers: 655, rating: [4.8, 410], hours: "6 AM – 11 AM, 5 PM – 10 PM", opening: { status: "open", date: days(-300) } },
  { slug: "midnight-maggi-point", name: "Midnight Maggi Point", kind: "street_stall", at: "izzatnagar", tagline: "Cheese maggi till 2 AM", description: "Twenty versions of Maggi, from tandoori to cheese-corn, served until 2 AM for the students and the night shift.", tags: ["maggi", "late night", "students"], emoji: "🍜", theme: ["#FFD60A", "#FF8500"], followers: 512, rating: [4.4, 201], hours: "8 PM – 2 AM", opening: { status: "open", date: days(-150) } },
  { slug: "kulhad-coffee-house", name: "Kulhad Coffee House", kind: "cafe", at: "modelTown", tagline: "Cold coffee, board games, rooftop seating", description: "A rooftop café with board games, acoustic Fridays and the thickest cold coffee in Model Town.", tags: ["cafe", "coffee", "board games"], emoji: "☕", theme: ["#6F4E37", "#2B2118"], followers: 930, rating: [4.5, 367], hours: "11 AM – 11 PM", price: 2, opening: { status: "open", date: days(-8) } },
  { slug: "jhumka-bakes", name: "Jhumka Bakes", kind: "bakery", at: "premNagar", tagline: "Fresh sourdough & jar cakes", description: "Small-batch sourdough, Biscoff jar cakes and custom birthday cakes, baked fresh every morning.", tags: ["bakery", "cakes", "sourdough"], emoji: "🎂", theme: ["#FF8FAB", "#C9184A"], followers: 415, rating: [4.6, 140], hours: "9 AM – 9 PM", price: 2, opening: { status: "open", date: days(-5) } },
  { slug: "desi-waffle-co", name: "Desi Waffle Co.", kind: "street_stall", at: "greenPark", tagline: "Gulab-jamun waffles. Yes, really.", description: "Belgian waffles meet Indian sweets: gulab jamun, rabri and kesar-pista waffles. Opening soon in Green Park.", tags: ["dessert", "waffles", "fusion"], emoji: "🧇", theme: ["#F4A261", "#E76F51"], opening: { status: "coming_soon", date: dayAt(6, 17) } },
  { slug: "green-bowl-salads", name: "Green Bowl", kind: "cafe", at: "civilLines", tagline: "Protein bowls for the gym crowd", description: "High-protein bowls, cold-pressed juices and smoothies. Built for runners, lifters and anyone tired of greasy food.", tags: ["healthy", "salads", "juices"], emoji: "🥗", theme: ["#80B918", "#2B9348"], price: 2, opening: { status: "coming_soon", date: dayAt(13, 11) } },
  { slug: "threads-and-co", name: "Threads & Co.", kind: "shop", at: "rajendraNagar", tagline: "Streetwear & sneakers, new in town", description: "Oversized tees, cargo pants and sneakers. Bareilly's first streetwear store opens with a launch-day sale.", tags: ["fashion", "streetwear", "sneakers"], emoji: "👟", theme: ["#3A0CA3", "#7209B7"], price: 2, opening: { status: "coming_soon", date: dayAt(3, 12) } },
  { slug: "smash-point-pickleball", name: "Smash Point Pickleball", kind: "sports_venue", at: "modelTown", tagline: "4 courts, floodlit, paddles on rent", description: "Four floodlit pickleball courts with paddle rental, coaching for beginners and Saturday mixers.", tags: ["pickleball", "sports", "courts"], emoji: "🏓", theme: ["#00B4D8", "#0077B6"], hours: "6 AM – 11 PM", followers: 301, rating: [4.7, 77], opening: { status: "open", date: days(-30) } },
  { slug: "box-cricket-hub", name: "Box Cricket Hub", kind: "sports_venue", at: "ddPuram", tagline: "Night box cricket under lights", description: "Two netted box cricket arenas with turf flooring and floodlights. Book in 1-hour slots.", tags: ["cricket", "box cricket", "turf"], emoji: "🏏", theme: ["#38B000", "#007200"], hours: "6 AM – 1 AM", followers: 688, rating: [4.5, 230], opening: { status: "open", date: days(-180) } },
];

const businesses = await Business.insertMany(
  seeds.map((s) => ({
    slug: s.slug, name: s.name, kind: s.kind, area: A[s.at].area, address: `${A[s.at].area}, Bareilly`,
    tagline: s.tagline, description: s.description, tags: s.tags, emoji: s.emoji,
    theme: { from: s.theme[0], to: s.theme[1] }, priceLevel: s.price ?? 1, hours: s.hours ?? "5 PM – 11 PM",
    location: pt(A[s.at].c), owner: merchant._id, verified: true,
    opening: { ...(s.opening ?? { status: "open", date: days(-60) }), notifyCount: s.opening?.status === "coming_soon" ? Math.floor(80 + Math.random() * 300) : 0 },
    live: s.live ? { isLive: true, spot: s.live.spot, location: pt(A[s.live.at].c), until: hrs(s.live.untilH), updatedAt: new Date() } : { isLive: false },
    followersCount: s.followers ?? Math.floor(Math.random() * 120),
    rating: { avg: s.rating?.[0] ?? 0, count: s.rating?.[1] ?? 0 },
  }))
);
const by = Object.fromEntries(businesses.map((b) => [b.slug, b._id]));

await Deal.insertMany([
  { business: by["momo-bros-truck"], title: "Free jhol momo plate", description: "On orders above ₹199. Show the code at the truck window.", kind: "freebie", limit: 50, claimedCount: 31, redeemedCount: 22, endsAt: days(2) },
  { business: by["bareilly-burger-garage"], title: "Launch week: 30% off any burger", description: "Celebrating our first month in Rajendra Nagar.", kind: "percent", value: 30, limit: 150, claimedCount: 118, redeemedCount: 84, endsAt: days(4) },
  { business: by["kulhad-coffee-house"], title: "Buy 1 get 1 cold coffee", description: "Opening week special, all day.", kind: "bogo", limit: 200, claimedCount: 76, redeemedCount: 40, endsAt: days(5) },
  { business: by["jhumka-bakes"], title: "First 100: free brownie", description: "With any jar cake, for our first 100 customers.", kind: "first_n", limit: 100, claimedCount: 64, redeemedCount: 51, endsAt: days(6) },
  { business: by["tandoori-tales-on-wheels"], title: "₹50 off on ₹300", description: "Valid tonight at the Pilibhit Bypass spot.", kind: "flat", value: 50, limit: 80, claimedCount: 12, redeemedCount: 5, endsAt: hrs(6) },
  { business: by["smash-point-pickleball"], title: "First hour free for beginners", description: "Paddles included. Weekday mornings only.", kind: "freebie", limit: 40, claimedCount: 17, redeemedCount: 9, endsAt: days(10) },
  { business: by["the-chai-cart-co"], title: "Runner's chai: ₹10 off", description: "Show your Sunday run club check-in.", kind: "flat", value: 10, limit: 300, claimedCount: 140, redeemedCount: 122, endsAt: days(14) },
]);

await Event.insertMany([
  { slug: "sunday-5k-run-club", title: "Sunday 5K Run Club", kind: "run_club", emoji: "🏃", description: "An easy-paced 5K loop around Gandhi Udyan, all levels welcome. Chai at The Chai Cart Co. after.", startsAt: nextDow(0, 6), endsAt: nextDow(0, 7, 30), venue: "Gandhi Udyan main gate", area: "Gandhi Udyan", location: pt(A.gandhiUdyan.c), organizer: "Bareilly Runners", price: 0, capacity: 150, rsvpCount: 86 },
  { slug: "food-truck-friday", title: "Food Truck Friday", kind: "food_fest", emoji: "🚚", description: "Eight food trucks, live acoustic music and fairy lights. Entry free; bring friends and an appetite.", startsAt: nextDow(5, 18), endsAt: nextDow(5, 23), venue: "Pilibhit Bypass open ground", area: "Pilibhit Bypass", location: pt(A.pilibhitBypass.c), organizer: "Nukkad", price: 0, capacity: 1500, rsvpCount: 640 },
  { slug: "night-riders-bike-ride", title: "Night Riders: Ramganga Ride", kind: "bike_ride", emoji: "🏍️", description: "A 40 km night ride to the Ramganga bridge and back. Helmets mandatory; ride captain and sweep rider assigned.", startsAt: nextDow(6, 21), endsAt: nextDow(6, 23, 59), venue: "Civil Lines petrol pump", area: "Civil Lines", location: pt(A.civilLines.c), organizer: "Bareilly Bikers Club", price: 0, capacity: 60, rsvpCount: 38 },
  { slug: "sunrise-cycling-loop", title: "Sunrise Cycling Loop", kind: "cycling", emoji: "🚴", description: "A 25 km sunrise loop for road and hybrid bikes. Regroup stops every 8 km.", startsAt: nextDow(6, 5, 45), endsAt: nextDow(6, 8), venue: "Model Town chauraha", area: "Model Town", location: pt(A.modelTown.c), organizer: "Pedal Bareilly", price: 0, capacity: 50, rsvpCount: 21 },
  { slug: "pickleball-beginners-mixer", title: "Pickleball Beginners Mixer", kind: "meetup", emoji: "🏓", description: "Never played? Learn the rules, rotate partners, make friends. Paddles provided.", startsAt: nextDow(6, 17), endsAt: nextDow(6, 19), venue: "Smash Point Pickleball", area: "Model Town", location: pt(A.modelTown.c), organizer: "Smash Point", price: 199, capacity: 32, rsvpCount: 24 },
  { slug: "box-cricket-saturday-league", title: "Box Cricket Saturday League", kind: "tournament", emoji: "🏏", description: "Eight teams of six, six-over knockouts under lights. ₹5,000 prize for the winners.", startsAt: nextDow(6, 19), endsAt: nextDow(6, 23, 30), venue: "Box Cricket Hub", area: "DD Puram", location: pt(A.ddPuram.c), organizer: "Box Cricket Hub", price: 1200, capacity: 8, rsvpCount: 6 },
  { slug: "tonight-acoustic-rooftop", title: "Acoustic Night on the Rooftop", kind: "meetup", emoji: "🎸", description: "Local musicians, cold coffee and fairy lights at Kulhad Coffee House.", startsAt: todayAt(20), endsAt: todayAt(23), venue: "Kulhad Coffee House", area: "Model Town", location: pt(A.modelTown.c), organizer: "Kulhad Coffee House", price: 0, capacity: 60, rsvpCount: 41 },
]);

await seedPlay({ merchantId: merchant._id, userIds });
await seedHost({ merchantId: merchant._id, organizerId: organizer._id, userIds });
await seedSocial({ merchantId: merchant._id, userIds });

console.log(`Seeded ${businesses.length} businesses, deals and events. Logins (OTP shown in dev mode): merchant 9999999999, organiser 9888888888, admin 9000000001.`);
await mongoose.disconnect();
