// api/admin.js
// Consolidated platform-admin functions:
//   GET  ?action=check-platform-admin
//   GET  ?action=list-users&tenantId=<uuid>
//   POST ?action=create-tenant-invite
//   POST ?action=update-user-roles
//   POST ?action=remove-user

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";
const VALID_ROLES = ["estimator","crew","crewlead","manager","owner"];

async function getCallerId(serviceKey, callerToken) {
  if (!callerToken) return null;
  const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { "apikey": serviceKey, "Authorization": "Bearer " + callerToken },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.id || null;
}

async function getCallerRole(serviceKey, callerId) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + callerId + "&select=role", {
    headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey },
  });
  const data = await res.json();
  return Array.isArray(data) && data[0]?.role ? data[0].role : "crew";
}

async function isPlatformAdmin(serviceKey, callerId) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/platform_admins?user_id=eq." + callerId + "&select=user_id", {
    headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey },
  });
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY" });

  const action = req.query.action;
  const authHeader = req.headers.authorization || "";
  const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // ── GET check-platform-admin ──────────────────────────────────────────────
  if (action === "check-platform-admin") {
    if (!callerToken) return res.status(200).json({ isPlatformAdmin: false });
    try {
      const callerId = await getCallerId(serviceKey, callerToken);
      if (!callerId) return res.status(200).json({ isPlatformAdmin: false });
      return res.status(200).json({ isPlatformAdmin: await isPlatformAdmin(serviceKey, callerId) });
    } catch(e) { return res.status(200).json({ isPlatformAdmin: false }); }
  }

  // ── GET list-users ────────────────────────────────────────────────────────
  if (action === "list-users") {
    const tenantId = req.query.tenantId;
    if (!tenantId) return res.status(400).json({ error: "tenantId required" });
    const sbH = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };
    try {
      const tuRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_users?tenant_id=eq." + tenantId + "&status=eq.active&select=user_id,role", { headers: sbH });
      const tuData = await tuRes.json();
      if (!Array.isArray(tuData) || tuData.length === 0) return res.status(200).json({ users: [] });
      const userIds = tuData.map(tu => tu.user_id);
      const profilesRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=in.(" + userIds.join(",") + ")&select=id,email,role,roles,created_at,first_name,last_name,phone,date_of_birth", { headers: sbH });
      const profiles = await profilesRes.json();
      const merged = (profiles || []).map(p => { const tu = tuData.find(t => t.user_id === p.id); return { ...p, role: tu?.role || p.role }; });
      return res.status(200).json({ users: merged });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST create-tenant-invite ─────────────────────────────────────────────
  if (action === "create-tenant-invite") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!callerToken) return res.status(401).json({ error: "Missing auth token" });
    const callerId = await getCallerId(serviceKey, callerToken);
    if (!callerId) return res.status(401).json({ error: "Could not verify identity" });
    if (!await isPlatformAdmin(serviceKey, callerId)) return res.status(403).json({ error: "Platform admins only" });
    try {
      const insertRes = await fetch(SUPABASE_URL + "/rest/v1/tenant_invites", {
        method: "POST",
        headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey, "Content-Type": "application/json", "Prefer": "return=representation" },
        body: JSON.stringify({ created_by: callerId }),
      });
      const insertData = await insertRes.json();
      if (!insertRes.ok) return res.status(500).json({ error: "Failed to create invite" });
      return res.status(200).json({ success: true, token: insertData[0]?.token });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST update-user-roles ────────────────────────────────────────────────
  if (action === "update-user-roles") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { userId, roles } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!Array.isArray(roles) || roles.length === 0) return res.status(400).json({ error: "roles required" });
    const cleanRoles = [...new Set(roles)].filter(r => VALID_ROLES.includes(r));
    if (cleanRoles.length === 0) return res.status(400).json({ error: "No valid roles" });
    const callerId = await getCallerId(serviceKey, callerToken);
    if (!callerId) return res.status(401).json({ error: "Could not verify identity" });
    const callerRole = await getCallerRole(serviceKey, callerId);
    if (callerRole !== "owner" && callerRole !== "admin") return res.status(403).json({ error: "Owners only" });
    try {
      const updateRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + userId, {
        method: "PATCH",
        headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey, "Content-Type": "application/json", "Prefer": "return=representation" },
        body: JSON.stringify({ roles: cleanRoles, role: cleanRoles[0] }),
      });
      if (!updateRes.ok) return res.status(500).json({ error: "Failed to update roles" });
      const updated = await updateRes.json();
      return res.status(200).json({ success: true, user: updated[0] || null });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST remove-user ──────────────────────────────────────────────────────
  if (action === "remove-user") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    const callerId = await getCallerId(serviceKey, callerToken);
    if (!callerId) return res.status(401).json({ error: "Could not verify identity" });
    const callerRole = await getCallerRole(serviceKey, callerId);
    if (callerRole !== "owner" && callerRole !== "admin") return res.status(403).json({ error: "Owners only" });
    try {
      const delRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + userId, {
        method: "DELETE",
        headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey },
      });
      if (!delRes.ok) return res.status(delRes.status).json({ error: "Failed to remove user" });
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── GET list-feedback (platform admin only) ──────────────────────────────
  if (action === "list-feedback") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const callerId = await getCallerId(serviceKey, token);
    if (!callerId) return res.status(401).json({ error: "Missing auth." });
    if (!await isPlatformAdmin(serviceKey, callerId)) return res.status(403).json({ error: "Platform admins only." });
    try {
      const r = await fetch(SUPABASE_URL + "/rest/v1/feedback?select=id,tenant_id,user_id,type,title,body,status,priority,internal_notes,submitter_name,submitter_email,company_name,created_at&order=created_at.desc&limit=200", {
        headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey },
      });
      const data = await r.json();
      return res.status(200).json({ feedback: Array.isArray(data) ? data : [] });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST update-feedback (platform admin only) ────────────────────────────
  if (action === "update-feedback") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const callerId = await getCallerId(serviceKey, token);
    if (!callerId) return res.status(401).json({ error: "Missing auth." });
    if (!await isPlatformAdmin(serviceKey, callerId)) return res.status(403).json({ error: "Platform admins only." });
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required." });
    // Allow patching any subset of allowed fields
    const { status, priority, internal_notes } = req.body || {};
    const patch = {};
    if (status !== undefined)         patch.status         = status;
    if (priority !== undefined)       patch.priority       = priority;
    if (internal_notes !== undefined) patch.internal_notes = internal_notes;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing to update." });
    try {
      await fetch(SUPABASE_URL + "/rest/v1/feedback?id=eq." + id, {
        method: "PATCH",
        headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey, "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: "Unknown action: " + action });
}
