// api/stripe-portal.js
// Creates a Stripe Customer Portal session and returns the redirect URL.
// The front-end sends the user there directly.

import Stripe from "stripe";

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const serviceKey     = process.env.SUPABASE_SERVICE_KEY;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!serviceKey)      return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY" });
  if (!stripeSecretKey) return res.status(500).json({ error: "Stripe is not configured yet. Contact support to set up billing." });

  // Authenticate caller — extract their JWT
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token. Please sign out and back in." });

  const sbH = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };

  // Verify the JWT against Supabase auth
  let userId;
  try {
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": serviceKey, "Authorization": "Bearer " + token },
    });
    if (!userRes.ok) {
      const errText = await userRes.text();
      console.error("[stripe-portal] auth/v1/user failed:", userRes.status, errText);
      return res.status(401).json({ error: "Session expired. Please sign out and sign back in." });
    }
    const userData = await userRes.json();
    userId = userData?.id;
    if (!userId) return res.status(401).json({ error: "Could not identify user. Please sign out and sign back in." });
  } catch (e) {
    return res.status(500).json({ error: "Auth check failed: " + e.message });
  }

  // Find tenant where this user is owner/admin
  const tuRes = await fetch(
    SUPABASE_URL + "/rest/v1/tenant_users?user_id=eq." + userId + "&role=in.(owner,admin)&select=tenant_id",
    { headers: sbH }
  );
  const tuData = await tuRes.json();
  const tenantId = Array.isArray(tuData) && tuData[0]?.tenant_id;
  if (!tenantId) return res.status(403).json({ error: "No owner-level tenant found for this user." });

  // Get the tenant's Stripe customer ID
  const tenantRes = await fetch(
    SUPABASE_URL + "/rest/v1/tenants?id=eq." + tenantId + "&select=data",
    { headers: sbH }
  );
  const tenantRows = await tenantRes.json();
  const stripeCustomerId = tenantRows?.[0]?.data?.stripeCustomerId;

  if (!stripeCustomerId) {
    return res.status(400).json({
      error: "No billing account on file yet. Contact support@blacktopiq.com to get set up.",
    });
  }

  // Create Stripe portal session
  try {
    const stripe  = new Stripe(stripeSecretKey);
    const session = await stripe.billingPortal.sessions.create({
      customer:   stripeCustomerId,
      return_url: req.headers.origin || "https://blacktopiq.com",
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[stripe-portal] Stripe error:", err.message);
    return res.status(500).json({ error: "Stripe error: " + err.message });
  }
}
