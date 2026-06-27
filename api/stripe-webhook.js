// Stripe webhook receiver — scaffold only, not wired to real tier updates yet.
//
// WHY THIS EXISTS NOW: tiers (Solo/Crew/Pro) are being held off until
// multi-tenancy ships, since a tier has to belong to a *customer* and there's
// only one customer (TPS) right now. But the webhook-handling shape — verify
// the signature, parse the event, map a dollar amount to a tier — doesn't
// depend on tenants existing. Building that piece now means there's only one
// thing left to do later: swap the two TODOs below for real tenant lookups.
//
// Deploy location: /api/stripe-webhook.js (Vercel auto-detects this as a
// serverless function at the path /api/stripe-webhook).
//
// SETUP STEPS (do these before this does anything useful):
// 1. npm install stripe
// 2. In Vercel's dashboard -> Project -> Settings -> Environment Variables, add:
//      STRIPE_SECRET_KEY       (from Stripe Dashboard -> Developers -> API keys)
//      STRIPE_WEBHOOK_SECRET   (from step 3 below, starts with "whsec_")
// 3. In Stripe Dashboard -> Developers -> Webhooks -> Add endpoint:
//      URL: https://<your-vercel-domain>/api/stripe-webhook
//      Events to send: invoice.payment_succeeded, customer.subscription.updated,
//                      customer.subscription.deleted
//    Stripe will show you the signing secret for STRIPE_WEBHOOK_SECRET above.
// 4. Update the placeholder price thresholds in TIER_PRICE_CENTS below to match
//    whatever you actually set up as your Solo/Crew/Pro prices in Stripe.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Vercel needs the raw, unparsed request body to verify Stripe's signature —
// if the body parser runs first, the signature check will always fail.
export const config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// PLACEHOLDER thresholds — replace with your real Stripe price amounts (in
// cents) once Solo/Crew/Pro pricing is finalized. Mapping by amount (rather
// than a fixed Stripe Price ID) is what lets this handle "however much came
// in this month" the way Mark described, but it means these numbers MUST
// match your actual prices exactly or accounts will get mis-tiered.
const TIER_PRICE_CENTS = {
  solo: 4900,   // e.g. $49/mo — EDIT ME
  crew: 9900,   // e.g. $99/mo — EDIT ME
  pro: 19900,   // e.g. $199/mo — EDIT ME
};

function amountToTier(amountCents) {
  if (amountCents >= TIER_PRICE_CENTS.pro) return "pro";
  if (amountCents >= TIER_PRICE_CENTS.crew) return "crew";
  if (amountCents >= TIER_PRICE_CENTS.solo) return "solo";
  return null; // didn't match any known tier price — log and investigate
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // Signature didn't match — either a misconfigured secret, or someone
    // hitting this endpoint who isn't actually Stripe. Reject either way.
    console.error("Stripe webhook signature verification failed:", err.message);
    res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    return;
  }

  switch (event.type) {
    case "invoice.payment_succeeded": {
      const invoice = event.data.object;
      const stripeCustomerId = invoice.customer;
      const amountPaidCents = invoice.amount_paid;
      const tier = amountToTier(amountPaidCents);

      // TODO once multi-tenancy ships: replace this log with a real lookup —
      //   1. Find the tenant row where data.stripeCustomerId === stripeCustomerId
      //   2. Set data.subscriptionTier = tier, data.subscriptionStatus = "active"
      //   3. PATCH/POST that tenant row via sbFetch, same pattern as every
      //      other table in this app.
      // If tier comes back null, the paid amount didn't match any known
      // price — that's worth alerting on rather than silently accepting it.
      console.log(`[stripe-webhook] invoice.payment_succeeded: customer=${stripeCustomerId} amount=${amountPaidCents}c tier=${tier ?? "UNKNOWN"}`);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const stripeCustomerId = subscription.customer;
      // TODO once multi-tenancy ships: re-derive tier from the subscription's
      // current price/amount and update the tenant the same way as above —
      // covers upgrades/downgrades that happen outside a fresh invoice.
      console.log(`[stripe-webhook] customer.subscription.updated: customer=${stripeCustomerId} status=${subscription.status}`);
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const stripeCustomerId = subscription.customer;
      // TODO once multi-tenancy ships: find the tenant by stripeCustomerId and
      // set data.subscriptionStatus = "canceled" (decide separately whether
      // a canceled account loses access immediately or at period end).
      console.log(`[stripe-webhook] customer.subscription.deleted: customer=${stripeCustomerId}`);
      break;
    }

    default:
      // Stripe sends many event types beyond the three above — anything
      // unhandled is intentionally ignored, not an error.
      console.log(`[stripe-webhook] unhandled event type: ${event.type}`);
  }

  // Always 200 once signature verification passes, even for unhandled event
  // types — Stripe retries (with backoff) on any non-2xx response, and
  // retrying something we're deliberately ignoring just wastes their retries
  // and clutters logs.
  res.status(200).json({ received: true });
}
