// api/invite.js
// Invites someone into an EXISTING company. Enforces the tenant's user cap
// from tenant.data.userCap (set by stripe-webhook.js) before sending the invite.
// Accepts "owner" as the new primary role name, with "admin" as legacy fallback.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

// Plan user caps — mirrors PLAN_USER_CAPS in App.jsx and stripe-webhook.js.
// Used as fallback when tenant.data.userCap isn't set yet.
const PLAN_USER_CAPS = {
  solo:      1,
  solo_plus: 1,
  crew:      5,
  crew_plus: 5,
  pro:       25,
  trial:     5,
};

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
  let callerId   = null;

  if (callerToken) {
    try {
      const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
        headers: { "apikey": serviceKey, "Authorization": "Bearer " + callerToken },
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        callerId = userData?.id;
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

  const isOwner = callerRole === "owner" || callerRole === "admin";
  if (!isOwner && callerRole !== "manager") {
    return res.status(403).json({ error: "You do not have permission to invite team members into this company." });
  }

  // ── User cap enforcement ────────────────────────────────────────────────────
  // Fetch tenant data to get plan and userCap
  const tenantRes = await fetch(
    SUPABASE_URL + "/rest/v1/tenants?id=eq." + tenantId + "&select=data",
    { headers: sbHeaders }
  );
  const tenantRows = await tenantRes.json();
  const tenantData = tenantRows?.[0]?.data || {};
  const plan = tenantData.plan || "trial";

  // userCap from tenant.data takes priority (handles Pro add-on seats);
  // fall back to plan default
  const userCap = tenantData.userCap || PLAN_USER_CAPS[plan] || 1;

  // Solo and Solo+ are capped at 1 — owner only, no invites allowed
  if (userCap <= 1) {
    return res.status(403).json({
      error: "Your current plan does not allow additional team members. Upgrade to Crew or higher to invite teammates.",
      code:  "USER_CAP_REACHED",
    });
  }

  // Count current active users on this tenant
  const countRes = await fetch(
    SUPABASE_URL + "/rest/v1/tenant_users?tenant_id=eq." + tenantId + "&status=eq.active&select=user_id",
    { headers: sbHeaders }
  );
  const currentUsers = await countRes.json();
  const currentCount = Array.isArray(currentUsers) ? currentUsers.length : 0;

  if (currentCount >= userCap) {
    return res.status(403).json({
      error: `Your plan allows up to ${userCap} user${userCap !== 1 ? "s" : ""}. You currently have ${currentCount}. Upgrade your plan or add seats to invite more teammates.`,
      code:  "USER_CAP_REACHED",
    });
  }

  // ── Send the invite ─────────────────────────────────────────────────────────
  const VALID_ROLES   = ["estimator","crew","crewlead","manager","owner"];
  const requestedRole = VALID_ROLES.includes(role) ? role : "crew";
  // Managers can only invite as crew; owners can invite at any role
  const safeRole = isOwner ? requestedRole : "crew";

  // Solo/Solo+ only allow Owner role — but we already blocked them above (userCap <= 1)
  // Crew/Crew+ and Pro allow all roles

  try {
    // 1. Invite via Supabase Admin API
    const inviteRes = await fetch(SUPABASE_URL + "/auth/v1/invite", {
      method:  "POST",
      headers: { ...sbHeaders, "Content-Type": "application/json" },
      body:    JSON.stringify({ email: email.trim() }),
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
      method:  "POST",
      headers: { ...sbHeaders, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body:    JSON.stringify({ id: userId, email: email.trim(), role: safeRole, roles: [safeRole] }),
    });
    if (!profileRes.ok) {
      const profileErr = await profileRes.text();
      return res.status(500).json({ error: "User invited, but failed to set up profile: " + profileErr });
    }

    // 3. Link to this tenant
    const tuInsertRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_users", {
      method:  "POST",
      headers: { ...sbHeaders, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body:    JSON.stringify({ id: Date.now(), tenant_id: tenantId, user_id: userId, role: safeRole, status: "active" }),
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
