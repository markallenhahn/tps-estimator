// api/remove-user.js
// Deletes a user's auth account and profile row, revoking their access entirely.
// Admin-only — verified server-side via the caller's own access token.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

  const { userId } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: "userId is required." });
  }

  // ── Verify the caller is an admin ──
  const authHeader = req.headers.authorization || "";
  const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  let callerRole = "crew";

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
    return res.status(403).json({ error: "Only admins can remove team members." });
  }

  try {
    // Delete the auth user (profile row cascades via FK on delete)
    const delRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + userId, {
      method: "DELETE",
      headers: {
        "apikey": serviceKey,
        "Authorization": "Bearer " + serviceKey,
      },
    });

    if (!delRes.ok) {
      const errText = await delRes.text();
      return res.status(delRes.status).json({ error: errText || "Failed to remove user." });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown server error." });
  }
}
