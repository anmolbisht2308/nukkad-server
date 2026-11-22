/* OTP delivery. Used only when OTP_DEV_MODE=false.
   MSG91 "OTP" API with a DLT-approved template; swap for Gupshup/Twilio by replacing this function. */
import { HttpError } from "./http.js";

export async function sendOtpSms(phone: string, code: string) {
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  if (!authKey || !templateId) throw new HttpError(503, "SMS is not configured yet");
  const url = `https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(templateId)}&mobile=91${phone}&otp=${code}`;
  const res = await fetch(url, { method: "POST", headers: { authkey: authKey, "content-type": "application/json" } });
  if (!res.ok) throw new HttpError(502, "Couldn't send the code, try again");
}
