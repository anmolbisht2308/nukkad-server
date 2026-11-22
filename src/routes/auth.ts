import { Router } from "express";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { body, HttpError, normalizePhone } from "../lib/http.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { Otp, User } from "../models/index.js";
import { sendOtpSms } from "../lib/sms.js";

const r = Router();
const hash = (code: string) => createHash("sha256").update(`${code}:${config.jwtSecret}`).digest("hex");

r.post("/otp", body(z.object({ phone: z.string() })), async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const recent = await Otp.countDocuments({ phone, expiresAt: { $gt: new Date(Date.now() + 4 * 60_000) } });
  if (recent > 0) throw new HttpError(429, "Please wait a minute before requesting another code");

  const code = String(randomInt(100000, 1000000));
  await Otp.deleteMany({ phone });
  await Otp.create({ phone, codeHash: hash(code), expiresAt: new Date(Date.now() + 5 * 60_000) });

  if (config.otpDevMode) {
    console.log(`[otp] ${phone} → ${code}`);
    res.json({ sent: true, devCode: code });
    return;
  }
  await sendOtpSms(phone, code);
  res.json({ sent: true });
});

r.post(
  "/verify",
  body(z.object({ phone: z.string(), code: z.string().length(6), name: z.string().trim().max(60).optional() })),
  async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const otp = await Otp.findOne({ phone });
    if (!otp || otp.expiresAt < new Date()) throw new HttpError(400, "Code expired, request a new one");
    if (otp.attempts >= 5) throw new HttpError(429, "Too many attempts, request a new code");
    if (otp.codeHash !== hash(req.body.code)) {
      otp.attempts += 1;
      await otp.save();
      throw new HttpError(400, "Wrong code");
    }
    await otp.deleteOne();

    const user = await User.findOneAndUpdate(
      { phone },
      { $setOnInsert: { phone }, ...(req.body.name ? { $set: { name: req.body.name } } : {}) },
      { upsert: true, returnDocument: "after" }
    );
    const token = signToken({ id: String(user._id), role: user.role as "user" });
    res.json({ token, user: { id: user._id, phone: user.phone, name: user.name, role: user.role } });
  }
);

r.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user!.id).lean();
  if (!user) throw new HttpError(401, "Please log in");
  res.json({ user: { id: user._id, phone: user.phone, name: user.name, role: user.role, follows: user.follows } });
});

export default r;
