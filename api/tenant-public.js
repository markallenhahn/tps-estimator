// api/tenant-public.js
// Returns public-safe tenant branding info for the estimate request form.
// No auth required — only returns company name, logo, and accent color.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing tenant id" });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const sbH = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };

  // Fetch tenant data
  const tRes = await fetch(
    SUPABASE_URL + "/rest/v1/tenants?id=eq." + id + "&select=data",
    { headers: sbH }
  );
  const tRows = await tRes.json();
  if (!Array.isArray(tRows) || tRows.length === 0) {
    return res.status(404).json({ error: "Tenant not found" });
  }
  const data = tRows[0].data || {};

  // Fetch company settings for logo + accent color
  const csRes = await fetch(
    SUPABASE_URL + "/rest/v1/company_settings?tenant_id=eq." + id + "&select=data&limit=1",
    { headers: sbH }
  );
  const csRows = await csRes.json();
  const cs = Array.isArray(csRows) && csRows[0]?.data || {};

  return res.status(200).json({
    companyName:  data.companyName || cs.name || "Your Contractor",
    logoB64:      cs.logoB64 || null,
    accentColor:  cs.accentColor || "#f0ab2e",
    servicesOffered: data.servicesOffered || [],
  });
}
