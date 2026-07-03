// api/team.js
// Consolidated team/invite functions:
//   POST ?action=invite
//   POST ?action=redeem-tenant-invite

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";
const PLAN_USER_CAPS = { solo:1, solo_plus:1, crew:5, crew_plus:5, pro:25, trial:5 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY" });

  const action = req.query.action;
  const sbH = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };

  // ── POST invite ───────────────────────────────────────────────────────────
  if (action === "invite") {
    const { email, role, tenantId } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email is required." });
    if (!tenantId) return res.status(400).json({ error: "tenantId is required." });

    const authHeader = req.headers.authorization || "";
    const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    let callerRole = "crew", callerId = null;

    if (callerToken) {
      try {
        const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { "apikey": serviceKey, "Authorization": "Bearer " + callerToken } });
        if (userRes.ok) {
          const userData = await userRes.json();
          callerId = userData?.id;
          if (callerId) {
            const tuRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_users?user_id=eq." + callerId + "&tenant_id=eq." + tenantId + "&select=role", { headers: sbH });
            const tuData = await tuRes.json();
            if (Array.isArray(tuData) && tuData[0]?.role) callerRole = tuData[0].role;
          }
        }
      } catch(e) {}
    }

    const isOwner = callerRole === "owner" || callerRole === "admin";
    if (!isOwner && callerRole !== "manager") return res.status(403).json({ error: "You do not have permission to invite team members." });

    const tenantRes = await fetch(SUPABASE_URL + "/rest/v1/tenants?id=eq." + tenantId + "&select=data", { headers: sbH });
    const tenantRows = await tenantRes.json();
    const tenantData = tenantRows?.[0]?.data || {};
    const plan = tenantData.plan || "trial";
    const userCap = tenantData.userCap || PLAN_USER_CAPS[plan] || 1;
    if (userCap <= 1) return res.status(403).json({ error: "Your plan does not allow additional team members.", code: "USER_CAP_REACHED" });

    const countRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_users?tenant_id=eq." + tenantId + "&status=eq.active&select=user_id", { headers: sbH });
    const currentUsers = await countRes.json();
    const currentCount = Array.isArray(currentUsers) ? currentUsers.length : 0;
    if (currentCount >= userCap) return res.status(403).json({ error: `Your plan allows up to ${userCap} users. You have ${currentCount}.`, code: "USER_CAP_REACHED" });

    const VALID_ROLES = ["estimator","crew","crewlead","manager","owner"];
    const requestedRole = VALID_ROLES.includes(role) ? role : "crew";
    const safeRole = isOwner ? requestedRole : "crew";

    try {
      const inviteRes = await fetch(SUPABASE_URL + "/auth/v1/invite", {
        method: "POST", headers: { ...sbH, "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const inviteData = await inviteRes.json();
      if (!inviteRes.ok && !inviteData?.id) return res.status(inviteRes.status).json({ error: inviteData.msg || "Failed to send invite." });

      const userId = inviteData.id || inviteData.user?.id;
      if (!userId) return res.status(500).json({ error: "No user ID returned." });

      await fetch(SUPABASE_URL + "/rest/v1/profiles", {
        method: "POST", headers: { ...sbH, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify({ id: userId, email: email.trim(), role: safeRole, roles: [safeRole] }),
      });
      await fetch(SUPABASE_URL + "/rest/v1/tenant_users", {
        method: "POST", headers: { ...sbH, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify({ id: Date.now(), tenant_id: tenantId, user_id: userId, role: safeRole, status: "active" }),
      });
      return res.status(200).json({ success: true, userId, email: email.trim(), role: safeRole });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST redeem-tenant-invite ─────────────────────────────────────────────
  if (action === "redeem-tenant-invite") {
    const { token, email, password, companyName, phone } = req.body || {};
    if (!token || !email || !password || !companyName) return res.status(400).json({ error: "Token, email, password, and company name are required." });
    if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    try {
      const inviteRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_invites?token=eq." + token + "&select=token,used_at", { headers: sbH });
      const inviteData = await inviteRes.json();
      if (!inviteRes.ok || !Array.isArray(inviteData) || inviteData.length === 0) return res.status(404).json({ error: "This invite link isn't valid." });
      if (inviteData[0].used_at) return res.status(409).json({ error: "This invite link has already been used." });

      const createUserRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
        method: "POST", headers: { ...sbH, "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, email_confirm: true }),
      });
      const userData = await createUserRes.json();
      if (!createUserRes.ok) return res.status(createUserRes.status).json({ error: userData.msg || "Could not create account." });
      const userId = userData.id;

      await fetch(SUPABASE_URL + "/rest/v1/profiles", {
        method: "POST", headers: { ...sbH, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify({ id: userId, email: email.trim(), role: "owner", roles: ["owner"] }),
      });

      const tenantRes = await fetch(SUPABASE_URL + "/rest/v1/tenants", {
        method: "POST", headers: { ...sbH, "Content-Type": "application/json", "Prefer": "return=representation" },
        body: JSON.stringify({ data: { companyName: companyName.trim(), phone: (phone||"").trim(), plan: null, userCap: 5, subscriptionStatus: null, trialEndsAt: new Date(Date.now() + 14*24*60*60*1000).toISOString(), setupComplete: false } }),
      });
      const tenantData2 = await tenantRes.json();
      if (!tenantRes.ok) return res.status(500).json({ error: "Failed to create company." });
      const tenantId = tenantData2[0]?.id;

      await fetch(SUPABASE_URL + "/rest/v1/tenant_users", {
        method: "POST", headers: { ...sbH, "Content-Type": "application/json" },
        body: JSON.stringify({ id: Date.now(), tenant_id: tenantId, user_id: userId, role: "owner", status: "active" }),
      });
      await fetch(SUPABASE_URL + "/rest/v1/tenant_invites?token=eq." + token, {
        method: "PATCH", headers: { ...sbH, "Content-Type": "application/json" },
        body: JSON.stringify({ used_at: new Date().toISOString(), tenant_id: tenantId }),
      });

      return res.status(200).json({ success: true, userId, tenantId, email: email.trim() });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: "Unknown action: " + action });
}
