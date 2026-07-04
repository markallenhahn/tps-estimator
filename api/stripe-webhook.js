// api/stripe-webhook.js
// Handles the full Stripe subscription lifecycle and writes plan data into
// the tenant row so the app can gate features by plan without a Stripe call
// on every page load.
//
// Fields written to tenant.data on each event:
//   plan                — "solo" | "solo_plus" | "crew" | "crew_plus" | "pro"
//   userCap             — integer (25 + add-on seats for pro, fixed for others)
//   subscriptionStatus  — "active" | "paused" | "canceled" | "past_due"
//   stripeCustomerId    — stored on first payment so future events can find tenant
//   stripeSubscriptionId
//   currentPeriodEnd    — ISO string, when the current billing period ends
//   ownerEmail          — from Stripe customer record, stored for reference
//   trialEndsAt         — set to 14 days after signup via redeem-tenant-invite.js
//
// PLAN PRICES (in cents) — must match your Stripe price configuration exactly:
//   Solo       $40/mo  = 4000
//   Solo+      $75/mo  = 7500
//   Crew       $120/mo = 12000
//   Crew+      $165/mo = 16500
//   Pro        $250/mo = 25000   (base; add-on seats are $20/mo each = 2000c)
//
// SETUP:
//   1. npm install stripe
//   2. Vercel env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
//   3. Stripe Dashboard → Webhooks → Add endpoint:
//        URL: https://<your-domain>/api/stripe-webhook
//        Events: customer.subscription.created, customer.subscription.updated,
//                customer.subscription.deleted, customer.subscription.paused,
//                customer.subscription.resumed, invoice.payment_succeeded,
//                invoice.payment_failed

import Stripe from "stripe";

const stripe        = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL  = "https://elzymtqlcceouftwhcdk.supabase.co";

export const config = { api: { bodyParser: false } };

// ── Plan config (mirrors PLAN_CONFIG in App.jsx) ──────────────────────────────
// Monthly prices in cents
const PLAN_PRICE_CENTS = {
  solo:      4000,
  solo_plus: 7500,
  crew:      12000,
  crew_plus: 16500,
  pro:       25000,
};
// Annual prices in cents (10 months = 2 months free)
const PLAN_PRICE_CENTS_YEARLY = {
  solo:      40000,
  solo_plus: 75000,
  crew:      120000,
  crew_plus: 165000,
  pro:       250000,
};
const PLAN_USER_CAPS = {
  solo:      1,
  solo_plus: 1,
  crew:      5,
  crew_plus: 5,
  pro:       25, // base; add-ons calculated below
};
const ADDON_SEAT_PRICE_CENTS = 2000;        // $20/mo per extra seat (Pro only)
const ADDON_SEAT_PRICE_CENTS_YEARLY = 20000; // $200/yr per extra seat

// Map the subscription's total amount to a plan key + userCap.
// Handles both monthly and annual billing amounts.
function derivePlanFromAmount(amountCents) {
  // Check annual prices first (they're larger, avoids false monthly matches)
  const yearlyEntries = Object.entries(PLAN_PRICE_CENTS_YEARLY).sort((a,b) => b[1]-a[1]);
  for (const [plan, price] of yearlyEntries) {
    if (amountCents >= price) {
      let userCap = PLAN_USER_CAPS[plan];
      if (plan === "pro" && amountCents > price) {
        userCap += Math.floor((amountCents - price) / ADDON_SEAT_PRICE_CENTS_YEARLY);
      }
      return { plan, userCap, interval: "yearly" };
    }
  }
  // Then monthly
  const entries = Object.entries(PLAN_PRICE_CENTS).sort((a,b) => b[1]-a[1]);
  for (const [plan, price] of entries) {
    if (amountCents >= price) {
      let userCap = PLAN_USER_CAPS[plan];
      if (plan === "pro" && amountCents > price) {
        userCap += Math.floor((amountCents - price) / ADDON_SEAT_PRICE_CENTS);
      }
      return { plan, userCap, interval: "monthly" };
    }
  }
  return { plan: null, userCap: 1, interval: "monthly" };
}

// ── Supabase helpers ───────────────────────────────────────────────────────────
const sbHeaders = (serviceKey) => ({
  "apikey":        serviceKey,
  "Authorization": "Bearer " + serviceKey,
  "Content-Type":  "application/json",
  "Prefer":        "return=representation",
});

async function findTenantByStripeCustomer(stripeCustomerId, serviceKey) {
  const res = await fetch(
    SUPABASE_URL + "/rest/v1/tenants?select=id,data&data->>stripeCustomerId=eq." + stripeCustomerId,
    { headers: sbHeaders(serviceKey) }
  );
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function updateTenantData(tenantId, patch, serviceKey) {
  // First fetch the current data blob so we can merge cleanly
  const getRes = await fetch(
    SUPABASE_URL + "/rest/v1/tenants?id=eq." + tenantId + "&select=data",
    { headers: sbHeaders(serviceKey) }
  );
  const rows = await getRes.json();
  const current = (Array.isArray(rows) && rows[0]?.data) || {};
  const updated = { ...current, ...patch };
  const patchRes = await fetch(
    SUPABASE_URL + "/rest/v1/tenants?id=eq." + tenantId,
    {
      method:  "PATCH",
      headers: sbHeaders(serviceKey),
      body:    JSON.stringify({ data: updated }),
    }
  );
  if (!patchRes.ok) {
    const err = await patchRes.text();
    console.error("[stripe-webhook] tenant update failed:", err);
  }
  return patchRes.ok;
}

// ── Raw body reader ────────────────────────────────────────────────────────────
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── Main handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY" });

  // Verify Stripe signature
  let event;
  try {
    const raw       = await readRawBody(req);
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err.message);
    return res.status(400).send("Webhook signature verification failed: " + err.message);
  }

  const log = (msg) => console.log("[stripe-webhook]", msg);

  try {
    switch (event.type) {

      // ── New subscription created or payment succeeded ───────────────────────
      case "customer.subscription.created":
      case "invoice.payment_succeeded": {
        const obj = event.data.object;
        const stripeCustomerId = obj.customer;
        // For invoice events, amount_paid is the field; for subscription, use items
        let amountCents;
        if (event.type === "invoice.payment_succeeded") {
          amountCents = obj.amount_paid;
        } else {
          // subscription.created — sum all items
          amountCents = (obj.items?.data || []).reduce((s, i) => s + (i.price?.unit_amount || 0) * (i.quantity || 1), 0);
        }
        const { plan, userCap } = derivePlanFromAmount(amountCents);
        log(`${event.type}: customer=${stripeCustomerId} amount=${amountCents}c → plan=${plan} userCap=${userCap}`);

        if (!plan) {
          log(`WARN: amount ${amountCents}c did not match any plan — skipping tenant update`);
          break;
        }

        const tenant = await findTenantByStripeCustomer(stripeCustomerId, serviceKey);
        if (!tenant) {
          log(`WARN: no tenant found for stripeCustomerId=${stripeCustomerId}`);
          break;
        }

        // Fetch owner email from Stripe
        let ownerEmail = null;
        try {
          const customer = await stripe.customers.retrieve(stripeCustomerId);
          ownerEmail = customer.email || null;
        } catch(e) { /* non-fatal */ }

        const subId = event.type === "invoice.payment_succeeded"
          ? obj.subscription
          : obj.id;
        const periodEnd = event.type === "invoice.payment_succeeded"
          ? (obj.lines?.data?.[0]?.period?.end ? new Date(obj.lines.data[0].period.end * 1000).toISOString() : null)
          : (obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null);

        await updateTenantData(tenant.id, {
          plan,
          userCap,
          subscriptionStatus:   "active",
          stripeCustomerId,
          stripeSubscriptionId: subId,
          currentPeriodEnd:     periodEnd,
          ownerEmail,
          pausedAt: null, // clear any previous pause
        }, serviceKey);
        break;
      }

      // ── Subscription updated (upgrade/downgrade/seat change) ───────────────
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const stripeCustomerId = sub.customer;
        const amountCents = (sub.items?.data || []).reduce((s, i) => s + (i.price?.unit_amount || 0) * (i.quantity || 1), 0);
        const { plan, userCap } = derivePlanFromAmount(amountCents);
        const status = sub.status; // "active" | "past_due" | "canceled" | etc.
        log(`subscription.updated: customer=${stripeCustomerId} amount=${amountCents}c → plan=${plan} status=${status}`);

        const tenant = await findTenantByStripeCustomer(stripeCustomerId, serviceKey);
        if (!tenant) { log(`WARN: no tenant for ${stripeCustomerId}`); break; }

        const patch = {
          subscriptionStatus:   status === "active" ? "active" : status,
          stripeSubscriptionId: sub.id,
          currentPeriodEnd:     sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
        };
        if (plan) { patch.plan = plan; patch.userCap = userCap; }
        await updateTenantData(tenant.id, patch, serviceKey);
        break;
      }

      // ── Subscription paused ────────────────────────────────────────────────
      case "customer.subscription.paused": {
        const sub = event.data.object;
        const tenant = await findTenantByStripeCustomer(sub.customer, serviceKey);
        if (!tenant) break;
        log(`subscription.paused: customer=${sub.customer}`);
        await updateTenantData(tenant.id, {
          subscriptionStatus: "paused",
          pausedAt: new Date().toISOString(),
        }, serviceKey);
        break;
      }

      // ── Subscription resumed ───────────────────────────────────────────────
      case "customer.subscription.resumed": {
        const sub = event.data.object;
        const tenant = await findTenantByStripeCustomer(sub.customer, serviceKey);
        if (!tenant) break;
        log(`subscription.resumed: customer=${sub.customer}`);
        await updateTenantData(tenant.id, {
          subscriptionStatus: "active",
          pausedAt: null,
        }, serviceKey);
        break;
      }

      // ── Subscription canceled ──────────────────────────────────────────────
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const tenant = await findTenantByStripeCustomer(sub.customer, serviceKey);
        if (!tenant) break;
        log(`subscription.deleted: customer=${sub.customer}`);
        await updateTenantData(tenant.id, {
          subscriptionStatus: "canceled",
          pausedAt: null,
        }, serviceKey);
        break;
      }

      // ── Payment failed ─────────────────────────────────────────────────────
      case "invoice.payment_failed": {
        const inv = event.data.object;
        const tenant = await findTenantByStripeCustomer(inv.customer, serviceKey);
        if (!tenant) break;
        log(`invoice.payment_failed: customer=${inv.customer}`);
        await updateTenantData(tenant.id, {
          subscriptionStatus: "past_due",
        }, serviceKey);
        break;
      }

      default:
        log(`unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error("[stripe-webhook] handler error:", err);
    // Still return 200 so Stripe doesn't retry — log to investigate
  }

  res.status(200).json({ received: true });
}
