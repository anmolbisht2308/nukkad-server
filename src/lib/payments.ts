import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";

/* One payment interface for the whole app.
   - No Razorpay keys in .env → "mock" mode: orders are fake and are confirmed instantly (dev/testing only).
   - RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET set → real Razorpay orders, verified by signature.
   Amounts are in rupees everywhere in our code; Razorpay wants paise. */

const keyId = process.env.RAZORPAY_KEY_ID;
const secret = process.env.RAZORPAY_KEY_SECRET;
export const paymentsLive = !!(keyId && secret);

export type PaymentOrder = { provider: "mock" | "razorpay"; orderId: string; amount: number; currency: "INR"; keyId?: string };
export type PaymentProof = { provider: "mock" | "razorpay"; orderId: string; paymentId?: string; signature?: string };

export async function createOrder(amountRupees: number, receipt: string, notes: Record<string, string> = {}): Promise<PaymentOrder> {
  if (amountRupees <= 0) throw new HttpError(400, "Nothing to pay");
  if (!paymentsLive) return { provider: "mock", orderId: `mock_${receipt}_${Date.now()}`, amount: amountRupees, currency: "INR" };
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` },
    body: JSON.stringify({ amount: Math.round(amountRupees * 100), currency: "INR", receipt: receipt.slice(0, 40), notes }),
  });
  if (!res.ok) throw new HttpError(502, "Payment provider error, try again");
  const o = (await res.json()) as { id: string };
  return { provider: "razorpay", orderId: o.id, amount: amountRupees, currency: "INR", keyId };
}

/** True only if the payment really happened. Mock proofs are rejected once live keys exist. */
export function verifyPayment(p: PaymentProof): boolean {
  if (p.provider === "mock") return !paymentsLive && p.orderId.startsWith("mock_");
  if (!secret || !p.paymentId || !p.signature) return false;
  const expected = createHmac("sha256", secret).update(`${p.orderId}|${p.paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(p.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
