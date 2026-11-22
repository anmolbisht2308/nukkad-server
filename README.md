# Nukkad — server

REST API for **Nukkad**, a hyperlocal city app for Tier 2/3 cities (starting with Bareilly).

Frontend: [nukkad-frontend](https://github.com/anmolbisht2308/nukkad-frontend).

**Stack:** Node.js, Express 5, MongoDB (Mongoose), Zod validation, JWT phone-OTP auth, TypeScript.

## Run locally

Needs MongoDB running on `127.0.0.1:27017` (e.g. `mongod --dbpath ./.data/db`).

```bash
npm install
cp .env.example .env
npm run seed      # demo Bareilly data (WIPES the database)
npm run dev       # http://localhost:4000
```

Dev mode: OTPs are returned in the API response (no SMS) and payments are simulated (no Razorpay keys).
Demo logins: merchant `9999999999` · organiser `9888888888` · admin `9000000001` · creator `9820000001`.

## API

| Mount | What |
|---|---|
| `/api/auth` | Phone OTP request / verify, `me` |
| `/api` (public) | City feed, stats, businesses, follow / notify, deal claims, events, RSVP, waitlist |
| `/api/merchant` | Business management, go live, deals, redeem codes, stats, cover photo upload |
| `/api/play` | Venues, courts, slot availability, bookings (unique slot lock prevents double booking), split payments, open games |
| `/api/venue` | Venue owner calendar: walk-ins, blocks, played / no-show, revenue, pricing |
| `/api/host` | Tournaments (knockout + league), fixtures, scores, event stall grids |
| `/api` (social) | Cities, notifications, points & leaderboard, creators, campaigns |

Background jobs (in-process, every 5 min): opening-tomorrow reminders and flipping openings to "open now".

## Production — still needed

- **SMS OTP:** `OTP_DEV_MODE=false` + `MSG91_AUTH_KEY` / `MSG91_TEMPLATE_ID` (`src/lib/sms.ts`, untested against MSG91).
- **Payments:** `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (`src/lib/payments.ts`, untested against Razorpay). Refunds are only flagged (`refund_due`); venue payouts not built.
- **Push / WhatsApp** delivery of notifications (in-app only; hook in `src/lib/notify.ts`).
- **Photo storage:** uploads go to `uploads/`; move to S3/R2.
- Set a strong `JWT_SECRET` and `WEB_ORIGIN` to the frontend URL.

```bash
npm run build && npm start
```
