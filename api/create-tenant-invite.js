// api/create-tenant-invite.js
// Generates a token that, when redeemed, creates a brand-new company (tenant)
// and signs up its first admin. This is a PLATFORM-level action — different
// from invite.js, which adds someone into a company that already exists.
//
// Gated by the platform_admins table, NOT a per-company "admin" role — a
// company's own admin should never be able to spin up arbitrary new
// companies on the platform. Manage who's on this list via SQL
// (insert/delete rows in platform_admins) rather than an env var, so adding
// an AsphaltIQ teammate doesn't require a redeploy.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

  // ── Verify the caller is in platform_admins, server-side ──
  const authHeader = req.headers.authorization || "";
  const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!callerToken) {
    return res.status(401).json({ error: "Missing auth token." });
  }

  let callerId = null;
  try {
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": serviceKey, "Authorization": "Bearer " + callerToken },
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      callerId = userData?.id || null;
    }
  } catch (e) { /* callerId stays null -> rejected below */ }

  if (!callerId) {
    return res.status(401).json({ error: "Could not verify your identity." });
  }

  const adminCheckRes = await fetch(SUPABASE_URL + "/rest/v1/platform_admins?user_id=eq." + callerId + "&select=user_id", {
    headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey },
  });
  const adminCheckData = await adminCheckRes.json();
  if (!Array.isArray(adminCheckData) || adminCheckData.length === 0) {
    return res.status(403).json({ error: "Only AsphaltIQ platform admins can create new company invites." });
  }

  try {
    const insertRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_invites", {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": "Bearer " + serviceKey,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({ created_by: callerId }),
    });
    const insertData = await insertRes.json();
    if (!insertRes.ok) {
      return res.status(500).json({ error: "Failed to create invite: " + JSON.stringify(insertData) });
    }
    return res.status(200).json({ success: true, token: insertData[0]?.token });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown server error." });
  }
}
