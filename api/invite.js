// api/invite.js
// Vercel serverless function — runs privately on the server, never in the browser.
// Uses the Supabase service_role key (stored as a Vercel environment variable)
// to invite a new user by email and assign them a role in the profiles table.
//
// Security note: this endpoint verifies the CALLER's own role server-side
// (via their access token) before honoring any requested role. A manager
// calling this directly cannot grant themselves or anyone else admin/manager
// access — the server forces "crew" regardless of what the client sends.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

  const { email, role } = req.body || {};
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Email is required." });
  }

  // ── Verify the caller's identity and role server-side ──
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

  if (callerRole !== "admin" && callerRole !== "manager") {
    return res.status(403).json({ error: "You do not have permission to invite team members." });
  }

  // Admins may set any role; managers are locked to "crew" no matter what they send.
  const VALID_ROLES = ["estimator","crew","crewlead","manager","admin"];
  const requestedRole = VALID_ROLES.includes(role) ? role : "crew";
  const safeRole = callerRole === "admin" ? requestedRole : "crew";

  try {
    // 1. Invite the user via Supabase Admin API — sends them a secure email
    //    with a link to set their own password.
    const inviteRes = await fetch(SUPABASE_URL + "/auth/v1/invite", {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": "Bearer " + serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: email.trim() }),
    });

    const inviteData = await inviteRes.json();

    if (!inviteRes.ok) {
      // Common case: user already exists
      return res.status(inviteRes.status).json({
        error: inviteData.msg || inviteData.error_description || "Failed to send invite.",
      });
    }

    const userId = inviteData.id || inviteData.user?.id;
    if (!userId) {
      return res.status(500).json({ error: "Invite sent but no user ID returned." });
    }

    // 2. Create their profile row with the chosen role
    const profileRes = await fetch(SUPABASE_URL + "/rest/v1/profiles", {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": "Bearer " + serviceKey,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({ id: userId, email: email.trim(), role: safeRole }),
    });

    if (!profileRes.ok) {
      const profileErr = await profileRes.text();
      return res.status(500).json({ error: "User invited, but failed to set role: " + profileErr });
    }

    return res.status(200).json({ success: true, userId, email: email.trim(), role: safeRole });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown server error." });
  }
}
