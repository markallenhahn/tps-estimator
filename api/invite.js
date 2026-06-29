// api/invite.js
// Invites someone into an EXISTING company (as opposed to create-tenant-invite.js,
// which creates a brand-new company entirely). Runs privately on the server,
// using the Supabase service_role key.
//
// Two real fixes from the original version:
//   1. It never created a tenant_users row at all — meaning anyone invited
//      this way had zero company memberships, and would get stuck on the
//      loading screen forever after setting their password (fetchTenants
//      would always come back empty). That's the actual bug causing it.
//   2. The caller's permission check used their GLOBAL profiles.role, not
//      their role AT THIS SPECIFIC COMPANY (tenant_users.role) — meaning
//      someone who's an admin at one company but only crew at another
//      could incorrectly invite people into the second company as if they
//      were its admin. Now checks tenant_users for the specific tenantId.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

  const { email, role, tenantId } = req.body || {};
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Email is required." });
  }
  if (!tenantId) {
    return res.status(400).json({ error: "tenantId is required." });
  }

  const sbHeaders = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };

  // ── Verify the caller's identity and THEIR ROLE AT THIS SPECIFIC TENANT ──
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
    } catch (e) { /* fall through with callerRole = "crew" */ }
  }

  if (callerRole !== "admin" && callerRole !== "manager") {
    return res.status(403).json({ error: "You do not have permission to invite team members into this company." });
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
      headers: { ...sbHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });

    const inviteData = await inviteRes.json();

    if (!inviteRes.ok) {
      // Common case: user already exists (e.g. inviting someone who already
      // belongs to a different company) — still need to add a tenant_users
      // row for THIS company below, using their existing user id.
      const existingId = inviteData?.id;
      if (!existingId) {
        return res.status(inviteRes.status).json({
          error: inviteData.msg || inviteData.error_description || "Failed to send invite.",
        });
      }
    }

    const userId = inviteData.id || inviteData.user?.id;
    if (!userId) {
      return res.status(500).json({ error: "Invite sent but no user ID returned." });
    }

    // 2. Create their profile row with the chosen role (global identity —
    //    if they already have a profile from another company, this just
    //    keeps it as-is via merge-duplicates rather than overwriting it).
    const profileRes = await fetch(SUPABASE_URL + "/rest/v1/profiles", {
      method: "POST",
      headers: { ...sbHeaders, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ id: userId, email: email.trim(), role: safeRole, roles: [safeRole] }),
    });

    if (!profileRes.ok) {
      const profileErr = await profileRes.text();
      return res.status(500).json({ error: "User invited, but failed to set up profile: " + profileErr });
    }

    // 3. THE ACTUAL FIX: link them to this specific company.
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
