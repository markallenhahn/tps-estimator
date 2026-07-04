// api/stripe-checkout.js
// Creates a Stripe Checkout session for a tenant to subscribe to a plan.
// Called when a user selects a plan in the app.

import Stripe from "stripe";

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

const PRICE_IDS = {
  solo:      { monthly: "price_1TpJAdKfSm6pYdHi3tAAZ07N", yearly: "price_1TpJBFKfSm6pYdHiLzGdJvuw" },
  solo_plus: { monthly: "price_1TpJBrKfSm6pYdHilGpTbrpW", yearly: "price_1TpJC8KfSm6pYdHigREZLf5g" },
  crew:      { monthly: "price_1ToHMCKfSm6pYdHigCl0Soif", yearly: "price_1TpJ9hKfSm6pYdHipY1Mq2qO" },
  crew_plus: { monthly: "price_1TpJD3KfSm6pYdHiZnddwVDw", yearly: "price_1TpJDHKfSm6pYdHi2x3kXSYt" },
  pro:       { monthly: "price_1TpJERKfSm6pYdHiVvCQkBRr", yearly: "price_1TpJEjKfSm6pYdHiO741CXdn" },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const stripeKey  = process.env.STRIPE_SECRET_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!stripeKey)  return res.status(500).json({ error: "Stripe is not configured." });
  if (!serviceKey) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY." });

  // Auth
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Missing auth token." });

  const sbH = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };

  const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { "apikey": serviceKey, "Authorization": "Bearer " + token },
  });
  if (!userRes.ok) return res.status(401).json({ error: "Session expired. Please sign in again." });
  const userData = await userRes.json();
  const userId = userData?.id;
  if (!userId) return res.status(401).json({ error: "Could not identify user." });

  const { plan, interval } = req.body || {};
  if (!plan || !PRICE_IDS[plan]) return res.status(400).json({ error: "Invalid plan: " + plan });
  if (!["monthly","yearly"].includes(interval)) return res.status(400).json({ error: "interval must be monthly or yearly" });

  const priceId = PRICE_IDS[plan][interval];

  // Get tenant
  const tuRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_users?user_id=eq." + userId + "&role=in.(owner,admin)&select=tenant_id", { headers: sbH });
  const tuData = await tuRes.json();
  const tenantId = Array.isArray(tuData) && tuData[0]?.tenant_id;
  if (!tenantId) return res.status(403).json({ error: "No owner-level tenant found." });

  // Get or create Stripe customer
  const tenantRes = await fetch(SUPABASE_URL + "/rest/v1/tenants?id=eq." + tenantId + "&select=data", { headers: sbH });
  const tenantRows = await tenantRes.json();
  const tenantData = tenantRows?.[0]?.data || {};

  const stripe = new Stripe(stripeKey);
  let customerId = tenantData.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userData.email,
      metadata: { tenant_id: tenantId },
    });
    customerId = customer.id;
    // Save stripeCustomerId to tenant
    await fetch(SUPABASE_URL + "/rest/v1/tenants?id=eq." + tenantId, {
      method: "PATCH",
      headers: { ...sbH, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { ...tenantData, stripeCustomerId: customerId } }),
    });
  }

  const origin = req.headers.origin || "https://tps-estimator.vercel.app";

  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: origin + "/?subscribed=true",
      cancel_url:  origin + "/",
      metadata: { tenant_id: tenantId },
      subscription_data: { metadata: { tenant_id: tenantId } },
    });
    return res.status(200).json({ url: session.url });
  } catch(e) {
    console.error("[stripe-checkout] error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
