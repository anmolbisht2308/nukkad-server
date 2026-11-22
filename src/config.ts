const required = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${k}`);
  return v;
};

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017/nukkad"),
  jwtSecret: required("JWT_SECRET", "dev-secret"),
  webOrigin: (process.env.WEB_ORIGIN ?? "http://localhost:3200").split(","),
  otpDevMode: process.env.OTP_DEV_MODE !== "false",
  isProd: process.env.NODE_ENV === "production",
};

if (config.isProd && config.jwtSecret === "dev-secret") throw new Error("Set JWT_SECRET in production");
