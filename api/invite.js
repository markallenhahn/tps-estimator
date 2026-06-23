// api/invite.js
// Vercel serverless function — runs privately on the server, never in the browser.
// Uses the Supabase service_role key (stored as a Vercel environment variable)
// to invite a new user by email and assign them a role in the profiles table.

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
  const safeRole = ["admin","manager"].includes(role) ? role : "crew";

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
