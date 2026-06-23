// api/list-users.js
// Returns all profiles (email + role) so the admin Team screen can display them.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

  try {
    const profilesRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?select=id,email,role,created_at&order=created_at.asc", {
      headers: {
        "apikey": serviceKey,
        "Authorization": "Bearer " + serviceKey,
      },
    });
    const profiles = await profilesRes.json();
    if (!profilesRes.ok) {
      return res.status(500).json({ error: "Failed to load users." });
    }
    return res.status(200).json({ users: profiles });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown server error." });
  }
}
