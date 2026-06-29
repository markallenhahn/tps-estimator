// api/list-users.js
// Returns the users who belong to ONE specific company (tenant) — NOT every
// profile in the database. Before this fix, it returned literally everyone
// who has ever signed up to BlacktopIQ across every company, which is why
// a brand-new company's admin showed up on TPS's "Current Team" page: the
// list was never scoped by tenant at all, since this endpoint predates
// multi-tenancy entirely.
//
// Requires a tenantId query param: /api/list-users?tenantId=<uuid>

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "Server is not configured (missing SUPABASE_SERVICE_KEY)." });
  }

  const tenantId = req.query.tenantId;
  if (!tenantId) {
    return res.status(400).json({ error: "tenantId query parameter is required." });
  }

  const sbHeaders = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };

  try {
    // 1. Who belongs to this tenant, and what role do they have THERE.
    const tuRes = await fetch(
      SUPABASE_URL + "/rest/v1/tenant_users?tenant_id=eq." + tenantId + "&status=eq.active&select=user_id,role",
      { headers: sbHeaders }
    );
    const tuData = await tuRes.json();
    if (!tuRes.ok) {
      return res.status(500).json({ error: "Failed to load team members." });
    }
    if (!Array.isArray(tuData) || tuData.length === 0) {
      return res.status(200).json({ users: [] });
    }

    // 2. Their actual profile info, for the ones found above.
    const userIds = tuData.map(tu => tu.user_id);
    const profilesRes = await fetch(
      SUPABASE_URL + "/rest/v1/profiles?id=in.(" + userIds.join(",") + ")&select=id,email,role,roles,created_at,first_name,last_name,phone,date_of_birth",
      { headers: sbHeaders }
    );
    const profiles = await profilesRes.json();
    if (!profilesRes.ok) {
      return res.status(500).json({ error: "Failed to load user profiles." });
    }

    // Merge: tenant_users.role is the authoritative role for THIS company —
    // a person could have a different role at a different company, so the
    // global profiles.role isn't the right thing to show here.
    const merged = (profiles || []).map(p => {
      const tu = tuData.find(t => t.user_id === p.id);
      return { ...p, role: tu?.role || p.role };
    });

    return res.status(200).json({ users: merged });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unknown server error." });
  }
}
