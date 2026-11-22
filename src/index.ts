import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose";
import { config } from "./config.js";
import { errorHandler } from "./lib/http.js";
import { openingAlerts, startJobs } from "./lib/jobs.js";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import auth from "./routes/auth.js";
import pub from "./routes/public.js";
import merchant from "./routes/merchant.js";
import play from "./routes/play.js";
import venue from "./routes/venue.js";
import host from "./routes/host.js";
import social from "./routes/social.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // behind Cloud Run / load balancer
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } })); // lets the web app show uploaded photos
app.use(cors({ origin: config.webOrigin }));
const smallJson = express.json({ limit: "100kb" });
const photoJson = express.json({ limit: "4mb" }); // base64 photo uploads only
app.use((req, res, next) => (req.path.endsWith("/photo") ? photoJson : smallJson)(req, res, next));
app.use("/uploads", express.static(path.resolve("uploads"), { maxAge: "7d", index: false }));
app.use(morgan(config.isProd ? "combined" : "dev"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 });
});
/** Cloud Scheduler hits this every 5 minutes in production. */
app.post("/internal/jobs", async (req, res) => {
  const given = Buffer.from(req.get("x-jobs-secret") ?? "");
  const want = Buffer.from(config.jobsSecret ?? "");
  if (!config.jobsSecret || given.length !== want.length || !timingSafeEqual(given, want)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await openingAlerts();
  res.json({ ok: true });
});
app.use("/api/auth", auth);
app.use("/api/merchant", merchant);
app.use("/api/play", play); // Phase 2: venues, slots, bookings, open games
app.use("/api/venue", venue); // Phase 2: venue-owner calendar & courts
app.use("/api/host", host); // Phase 3: tournaments, fixtures, scores, event stalls
app.use("/api", social); // notifications, points, creators, cities, uploads
app.use("/api", pub);
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});
app.use(errorHandler);

await mongoose.connect(config.mongoUri);
await mongoose.syncIndexes();
if (!config.onCloudRun) startJobs();
app.listen(config.port, () => console.log(`API ready on http://localhost:${config.port}`));
