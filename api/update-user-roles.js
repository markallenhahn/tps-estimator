// api/update-user-roles.js
// Vercel serverless function — lets an admin change an EXISTING user's role(s)
// without removing and re-inviting them. Same server-side caller-verification
// pattern as invite.js, but admin-only (stricter than invite.js, which also
// lets managers invite at the "crew" level) — this endpoint can grant
// admin/manager access to an account that already exists, so it doesn't get
// the same manager-level allowance.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";
const VALID_ROLES = ["estimator","crew","crewlead","manager","admin"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

  const { userId, roles } = req.body || {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId is required." });
  }
  if (!Array.isArray(roles) || roles.length === 0) {
    return res.status(400).json({ error: "At least one role is required." });
  }
  const cleanRoles = [...new Set(roles)].filter(r => VALID_ROLES.includes(r));
  if (cleanRoles.length === 0) {
    return res.status(400).json({ error: "No valid roles provided." });
  }

  // ── Verify the caller is an admin, server-side — never trust the client ──
  const authHeader = req.headers.authorization || "";
  const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  let callerRole = "crew"; // fail closed: assume least privilege if anything is missing/invalid

  if (callerToken) {
    try {
      const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
        headers: { "apikey": serviceKey, "Authorization": "Bearer " + callerToken },
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        const callerId = userData?.id;
        if (callerId) {
          const profileRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + callerId + "&select=role", {
            headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey },
          });
          const profileData = await profileRes.json();
          if (Array.isArray(profileData) && profileData[0]?.role) {
            callerRole = profileData[0].role;
          }
        }
      }
    } catch (e) { /* fall through with callerRole = "crew" */ }
  }

  if (callerRole !== "admin") {
    return res.status(403).json({ error: "Only an admin can change another user's roles." });
  }

  try {
    // Keep the legacy "role" column in sync as the first entry in "roles" —
    // anything in the app that still only reads the single "role" field
    // (display labels, anything not yet updated to be multi-role-aware)
    // keeps working sensibly off whichever role is listed first.
    const updateRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + userId, {
      method: "PATCH",
      headers: {
        "apikey": serviceKey,
        "Authorization": "Bearer " + serviceKey,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({ roles: cleanRoles, role: cleanRoles[0] }),
    });

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      return res.status(500).json({ error: "Failed to update roles: " + errText });
    }

    const updated = await updateRes.json();
    return res.status(200).json({ success: true, user: updated[0] || null });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown server error." });
  }
}
