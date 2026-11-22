import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";

export type AuthUser = { id: string; role: "user" | "merchant" | "organizer" | "admin" };

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

export const signToken = (u: AuthUser) => jwt.sign(u, config.jwtSecret, { expiresIn: "30d" });

const read = (header?: string): AuthUser | undefined => {
  if (!header?.startsWith("Bearer ")) return;
  try {
    const p = jwt.verify(header.slice(7), config.jwtSecret) as AuthUser;
    return { id: p.id, role: p.role };
  } catch {
    return;
  }
};

export const optionalAuth: RequestHandler = (req, _res, next) => {
  req.user = read(req.headers.authorization);
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  req.user = read(req.headers.authorization);
  if (!req.user) throw new HttpError(401, "Please log in");
  next();
};

export const requireRole =
  (...roles: AuthUser["role"][]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) throw new HttpError(403, "Not allowed");
    next();
  };
