// api/invite.js
// Invites someone into an EXISTING company. Checks tenant_users.role for
// the caller's role at THIS specific tenant (not their global profiles.role).
// Accepts "owner" as the new primary role name, with "admin" as legacy fallback.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });

  const { email, role, tenantId } = req.body || {};
  if (!email || typeof email !== "string") return res.status(400).json({ error: "Email is required." });
  if (!tenantId) return res.status(400).json({ error: "tenantId is required." });

  const sbHeaders = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };

  // Verify the caller's role at THIS specific tenant
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
          const tuRes = await fetch(
            SUPABASE_URL + "/rest/v1/tenant_users?user_id=eq." + callerId + "&tenant_id=eq." + tenantId + "&select=role",
            { headers: sbHeaders }
          );
          const tuData = await tuRes.json();
          if (Array.isArray(tuData) && tuData[0]?.role) {
            callerRole = tuData[0].role;
          }
        }
      }
    } catch (e) { /* fall through */ }
  }

  // Accept "owner" (new) and "admin" (legacy) as authorized roles
  const isOwner = callerRole === "owner" || callerRole === "admin";
  if (!isOwner && callerRole !== "manager") {
    return res.status(403).json({ error: "You do not have permission to invite team members into this company." });
  }

  // Valid roles — "owner" replaces "admin" as the top tenant role
  const VALID_ROLES = ["estimator","crew","crewlead","manager","owner"];
  const requestedRole = VALID_ROLES.includes(role) ? role : "crew";
  // Managers can only invite as crew; owners can invite as any role
  const safeRole = isOwner ? requestedRole : "crew";

  try {
    // 1. Invite via Supabase Admin API
    const inviteRes = await fetch(SUPABASE_URL + "/auth/v1/invite", {
      method: "POST",
      headers: { ...sbHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });

    const inviteData = await inviteRes.json();

    if (!inviteRes.ok) {
      const existingId = inviteData?.id;
      if (!existingId) {
        return res.status(inviteRes.status).json({
          error: inviteData.msg || inviteData.error_description || "Failed to send invite.",
        });
      }
    }

    const userId = inviteData.id || inviteData.user?.id;
    if (!userId) return res.status(500).json({ error: "Invite sent but no user ID returned." });

    // 2. Create/update profile row
    const profileRes = await fetch(SUPABASE_URL + "/rest/v1/profiles", {
      method: "POST",
      headers: { ...sbHeaders, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ id: userId, email: email.trim(), role: safeRole, roles: [safeRole] }),
    });

    if (!profileRes.ok) {
      const profileErr = await profileRes.text();
      return res.status(500).json({ error: "User invited, but failed to set up profile: " + profileErr });
    }

    // 3. Link them to this specific company
    const tuInsertRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_users", {
      method: "POST",
      headers: { ...sbHeaders, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ id: Date.now(), tenant_id: tenantId, user_id: userId, role: safeRole, status: "active" }),
    });
    if (!tuInsertRes.ok) {
      const tuErr = await tuInsertRes.text();
      return res.status(500).json({ error: "User invited, but failed to add them to this company: " + tuErr });
    }

    return res.status(200).json({ success: true, userId, email: email.trim(), role: safeRole });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown server error." });
  }
}
