// api/remove-user.js
// Deletes a user's auth account and profile row, revoking their access entirely.

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
