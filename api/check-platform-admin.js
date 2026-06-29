// api/check-platform-admin.js
// Lets the app's UI know whether the logged-in user is an AsphaltIQ platform
// admin (so it can show/hide platform-only features like New Company
// Invites), WITHOUT ever sending the actual admin list to the browser —
// the client only ever learns "yes" or "no" about itself.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

  const authHeader = req.headers.authorization || "";
  const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!callerToken) {
    return res.status(200).json({ isPlatformAdmin: false });
  }

  try {
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": serviceKey, "Authorization": "Bearer " + callerToken },
    });
    if (!userRes.ok) return res.status(200).json({ isPlatformAdmin: false });
    const userData = await userRes.json();
    const callerId = userData?.id;
    if (!callerId) return res.status(200).json({ isPlatformAdmin: false });

    const checkRes = await fetch(SUPABASE_URL + "/rest/v1/platform_admins?user_id=eq." + callerId + "&select=user_id", {
      headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey },
    });
    const checkData = await checkRes.json();
    return res.status(200).json({ isPlatformAdmin: Array.isArray(checkData) && checkData.length > 0 });
  } catch (e) {
    return res.status(200).json({ isPlatformAdmin: false });
  }
}
