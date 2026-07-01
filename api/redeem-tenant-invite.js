// api/redeem-tenant-invite.js
// Creates a brand-new company and its first owner account from a platform invite token.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });

  const { token, email, password, companyName, phone } = req.body || {};
  if (!token || !email || !password || !companyName) {
    return res.status(400).json({ error: "Token, email, password, and company name are all required." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const sbHeaders = {
    "apikey": serviceKey,
    "Authorization": "Bearer " + serviceKey,
    "Content-Type": "application/json",
  };

  try {
    // 1. Verify the token
    const inviteRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_invites?token=eq." + token + "&select=token,used_at", { headers: sbHeaders });
    const inviteData = await inviteRes.json();
    if (!inviteRes.ok || !Array.isArray(inviteData) || inviteData.length === 0) {
      return res.status(404).json({ error: "This invite link isn't valid." });
    }
    if (inviteData[0].used_at) {
      return res.status(409).json({ error: "This invite link has already been used." });
    }

    // 2. Create the Auth user
    const createUserRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({ email: email.trim(), password, email_confirm: true }),
    });
    const userData = await createUserRes.json();
    if (!createUserRes.ok) {
      return res.status(createUserRes.status).json({ error: userData.msg || userData.error_description || "Could not create account — that email may already be in use." });
    }
    const userId = userData.id;

    // 3. Create their profile — "owner" is the tenant-level top role
    const profileRes = await fetch(SUPABASE_URL + "/rest/v1/profiles", {
      method: "POST",
      headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ id: userId, email: email.trim(), role: "owner", roles: ["owner"] }),
    });
    if (!profileRes.ok) {
      const errText = await profileRes.text();
      return res.status(500).json({ error: "Account created, but failed to set up profile: " + errText });
    }

    // 4. Create the new tenant
    const tenantRes = await fetch(SUPABASE_URL + "/rest/v1/tenants", {
      method: "POST",
      headers: { ...sbHeaders, "Prefer": "return=representation" },
      body: JSON.stringify({
        data: {
          companyName: companyName.trim(),
          phone: (phone || "").trim(),
          plan: null,
          userCap: 5,
          subscriptionStatus: null,
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          setupComplete: false,
        },
      }),
    });
    const tenantData = await tenantRes.json();
    if (!tenantRes.ok) {
      return res.status(500).json({ error: "Account created, but failed to create company: " + JSON.stringify(tenantData) });
    }
    const tenantId = tenantData[0]?.id;

    // 5. Link them as owner
    const tuRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_users", {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({ id: Date.now(), tenant_id: tenantId, user_id: userId, role: "owner", status: "active" }),
    });
    if (!tuRes.ok) {
      const errText = await tuRes.text();
      return res.status(500).json({ error: "Account and company created, but failed to link them: " + errText });
    }

    // 6. Mark invite as used AND record which tenant it created — this is
    // what lets Platform Admin show "this link created this company"
    // instead of invites and companies being two disconnected lists.
    await fetch(SUPABASE_URL + "/rest/v1/tenant_invites?token=eq." + token, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify({ used_at: new Date().toISOString(), tenant_id: tenantId }),
    });

    return res.status(200).json({ success: true, userId, tenantId, email: email.trim() });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown server error." });
  }
}
