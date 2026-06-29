// api/redeem-tenant-invite.js
// Takes a valid, unused tenant_invites token plus a new company's basic info
// and the new admin's chosen email/password, and creates everything needed:
// the Supabase Auth user, their profiles row, a brand-new tenant, and the
// tenant_users row that makes them that tenant's first admin.
//
// Uses the Admin API (service role key) to create the user directly with a
// confirmed email and the password they chose — no separate "check your
// email" step, since this person arrived via a link you already sent them,
// not a cold signup.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

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
    // 1. Verify the token exists and hasn't been used yet.
    const inviteRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_invites?token=eq." + token + "&select=token,used_at", { headers: sbHeaders });
    const inviteData = await inviteRes.json();
    if (!inviteRes.ok || !Array.isArray(inviteData) || inviteData.length === 0) {
      return res.status(404).json({ error: "This invite link isn't valid." });
    }
    if (inviteData[0].used_at) {
      return res.status(409).json({ error: "This invite link has already been used." });
    }

    // 2. Create the Auth user directly — confirmed, with their chosen password.
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

    // 3. Create their profile — admin of their own brand-new company.
    const profileRes = await fetch(SUPABASE_URL + "/rest/v1/profiles", {
      method: "POST",
      headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({ id: userId, email: email.trim(), role: "admin", roles: ["admin"] }),
    });
    if (!profileRes.ok) {
      const errText = await profileRes.text();
      return res.status(500).json({ error: "Account created, but failed to set up profile: " + errText });
    }

    // 4. Create the new tenant itself.
    const tenantRes = await fetch(SUPABASE_URL + "/rest/v1/tenants", {
      method: "POST",
      headers: { ...sbHeaders, "Prefer": "return=representation" },
      body: JSON.stringify({
        data: {
          companyName: companyName.trim(),
          phone: (phone || "").trim(),
          subscriptionTier: null,
          subscriptionStatus: "trial",
          setupComplete: false,
        },
      }),
    });
    const tenantData = await tenantRes.json();
    if (!tenantRes.ok) {
      return res.status(500).json({ error: "Account created, but failed to create company: " + JSON.stringify(tenantData) });
    }
    const tenantId = tenantData[0]?.id;

    // 5. Link them to it as admin.
    const tuRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_users", {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({ id: Date.now(), tenant_id: tenantId, user_id: userId, role: "admin", status: "active" }),
    });
    if (!tuRes.ok) {
      const errText = await tuRes.text();
      return res.status(500).json({ error: "Account and company created, but failed to link them: " + errText });
    }

    // 6. Mark the invite as used.
    await fetch(SUPABASE_URL + "/rest/v1/tenant_invites?token=eq." + token, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify({ used_at: new Date().toISOString() }),
    });

    return res.status(200).json({ success: true, userId, tenantId, email: email.trim() });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown server error." });
  }
}
