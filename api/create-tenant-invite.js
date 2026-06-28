// api/create-tenant-invite.js
// Generates a token that, when redeemed, creates a brand-new company (tenant)
// and signs up its first admin. This is a PLATFORM-level action — different
// from invite.js, which adds someone into a company that already exists.
//
// Gated to a hardcoded allowlist of platform-admin emails (env var), not just
// "any admin role" — an admin at one company should never be able to spin up
// arbitrary new companies on the platform. Add your own email to the
// PLATFORM_ADMIN_EMAILS env var in Vercel (comma-separated if more than one).

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

  const allowlist = (process.env.PLATFORM_ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowlist.length === 0) {
    return res.status(500).json({ error: "Server is not configured (missing PLATFORM_ADMIN_EMAILS)." });
  }

  // ── Verify the caller is on the platform-admin allowlist, server-side ──
  const authHeader = req.headers.authorization || "";
  const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!callerToken) {
    return res.status(401).json({ error: "Missing auth token." });
  }

  let caller = null;
  try {
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": serviceKey, "Authorization": "Bearer " + callerToken },
    });
    if (userRes.ok) caller = await userRes.json();
  } catch (e) { /* caller stays null -> rejected below */ }

  const callerEmail = (caller?.email || "").toLowerCase();
  if (!caller?.id || !allowlist.includes(callerEmail)) {
    return res.status(403).json({ error: "Only the platform owner can create new company invites." });
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
      body: JSON.stringify({ created_by: caller.id }),
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
