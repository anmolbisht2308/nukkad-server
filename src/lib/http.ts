import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError, type ZodType } from "zod";
import mongoose from "mongoose";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new HttpError(404, what);

/** Parse and replace req.body with the validated value. */
export const body =
  <T>(schema: ZodType<T>): RequestHandler =>
  (req, _res, next) => {
    req.body = schema.parse(req.body ?? {});
    next();
  };

export const parseQuery = <T>(schema: ZodType<T>, q: unknown) => schema.parse(q);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid input", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ error: `Invalid ${err.path}` });
    return;
  }
  if ((err as { code?: number }).code === 11000) {
    res.status(409).json({ error: "Already exists" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
};

/** "+91 98765-43210" → "9876543210" (Indian 10-digit mobile). */
export const normalizePhone = (raw: string) => {
  const digits = raw.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  if (!/^[6-9]\d{9}$/.test(digits)) throw new HttpError(400, "Enter a valid 10-digit mobile number");
  return digits;
};
