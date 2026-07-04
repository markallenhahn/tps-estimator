// api/public.js
// Consolidated public/unauthenticated-friendly functions:
//   GET  ?action=tenant-public&id=<tenantId>
//   GET  ?action=geocode-census&address=<address>
//   POST ?action=submit-request
//   POST ?action=send-estimate-email  (auth required)

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  // ── GET tenant-public ─────────────────────────────────────────────────────
  if (action === "tenant-public") {
    if (!serviceKey) return res.status(500).json({ error: "Server misconfigured" });
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing tenant id" });
    const sbH = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };
    const tRes = await fetch(SUPABASE_URL + "/rest/v1/tenants?id=eq." + id + "&select=data", { headers: sbH });
    const tRows = await tRes.json();
    if (!Array.isArray(tRows) || tRows.length === 0) return res.status(404).json({ error: "Tenant not found" });
    const data = tRows[0].data || {};
    const csRes = await fetch(SUPABASE_URL + "/rest/v1/company_settings?tenant_id=eq." + id + "&select=data&limit=1", { headers: sbH });
    const csRows = await csRes.json();
    const cs = Array.isArray(csRows) && csRows[0]?.data || {};
    return res.status(200).json({
      companyName: data.companyName || cs.name || "Your Contractor",
      logoB64: cs.logoB64 || null,
      accentColor: cs.accentColor || "#f0ab2e",
      servicesOffered: data.servicesOffered || [],
    });
  }

  // ── GET geocode-census ────────────────────────────────────────────────────
  if (action === "geocode-census") {
    const address = req.query.address;
    if (!address || !String(address).trim()) return res.status(400).json({ error: "Missing address" });
    try {
      const url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(address);
      const censusRes = await fetch(url);
      const data = await censusRes.json();
      return res.status(censusRes.ok ? 200 : censusRes.status).json(data);
    } catch(e) { return res.status(502).json({ error: "Census geocoder failed", detail: String(e?.message || e) }); }
  }

  // ── POST submit-request ───────────────────────────────────────────────────
  if (action === "submit-request") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!serviceKey) return res.status(500).json({ error: "Server misconfigured" });
    const { tenantId, name, phone, email, address, city, state, zip, services, notes, photos } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: "Missing tenant ID" });
    if (!name?.trim()) return res.status(400).json({ error: "Name is required" });
    if (!phone?.trim() && !email?.trim()) return res.status(400).json({ error: "Phone or email required" });
    if (!address?.trim()) return res.status(400).json({ error: "Address is required" });
    if (!services?.length) return res.status(400).json({ error: "At least one service is required" });

    const sbH = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey, "Content-Type": "application/json", "Prefer": "return=representation" };

    const photoUrls = [];
    if (Array.isArray(photos) && photos.length > 0) {
      for (const photo of photos.slice(0, 5)) {
        try {
          if (!photo.dataUrl) continue;
          const base64 = photo.dataUrl.split(",")[1];
          const buffer = Buffer.from(base64, "base64");
          const ext = photo.name?.split(".").pop()?.toLowerCase() || "jpg";
          const path = `${tenantId}/requests/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
          const upRes = await fetch(SUPABASE_URL + "/storage/v1/object/estimate-requests/" + path, {
            method: "POST",
            headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey, "Content-Type": "image/" + ext },
            body: buffer,
          });
          if (upRes.ok) photoUrls.push(SUPABASE_URL + "/storage/v1/object/public/estimate-requests/" + path);
        } catch(e) {}
      }
    }

    const servicesLine = "Services requested: " + services.join(", ");
    const notesLine = notes?.trim() ? "\n\nClient notes: " + notes.trim() : "";
    const photosLine = photoUrls.length > 0 ? "\n\nPhotos:\n" + photoUrls.join("\n") : "";
    const fullNotes = servicesLine + notesLine + photosLine + "\n\n[Submitted via estimate request form]";
    const now = new Date();
    const mm = String(now.getMonth()+1).padStart(2,"0");
    const dd = String(now.getDate()).padStart(2,"0");
    const jobId = Date.now();

    const job = {
      id: jobId, tenant_id: tenantId,
      data: {
        id: jobId, clientName: name.trim(), clientPhone: phone?.trim()||"", clientEmail: email?.trim()||"",
        address: address.trim(), city: city?.trim()||"", state: state?.trim()||"", zip: zip?.trim()||"",
        fullAddress: [address,city,state,zip].filter(Boolean).join(", "),
        status: "estimate", source: "request_form",
        estimateNum: `EST-${mm}${dd}-001`,
        date: now.toISOString().slice(0,10),
        notes: fullNotes, areas: [], photoUrls,
        readyForReview: false, statusChangedAt: now.toISOString(),
      },
    };

    const jobRes = await fetch(SUPABASE_URL + "/rest/v1/jobs", { method: "POST", headers: sbH, body: JSON.stringify(job) });
    if (!jobRes.ok) {
      const err = await jobRes.text();
      console.error("[submit-request] job insert failed:", err);
      return res.status(500).json({ error: "Failed to submit request." });
    }
    return res.status(200).json({ success: true, jobId });
  }

  // ── POST send-estimate-email ──────────────────────────────────────────────
  if (action === "send-estimate-email") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY not configured." });
    if (!serviceKey) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY not configured." });

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing auth token." });
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { "apikey": serviceKey, "Authorization": "Bearer " + token } });
    if (!userRes.ok) return res.status(401).json({ error: "Session expired." });

    const { toEmail, toName, subject, pdfBase64, pdfFilename, fromName, fromPhone, fromEmail, ownerName } = req.body || {};
    if (!toEmail) return res.status(400).json({ error: "Client email is required." });
    if (!pdfBase64) return res.status(400).json({ error: "PDF data is required." });

    const greeting   = toName ? `${toName},` : "Hello,";
    const company    = fromName || "Us";
    const phone      = fromPhone || "";
    const email      = fromEmail || "";
    const owner      = ownerName || fromName || "";
    const phoneLine  = phone ? `by phone at ${phone}` : "";
    const emailLine  = email ? `by email at ${email}` : "";
    const contactStr = [phoneLine, emailLine].filter(Boolean).join(" or ");

    const emailBody = `${greeting}

Please see attached for your estimate from ${company}.${contactStr ? ` Please let us know if you have any questions. We can be reached ${contactStr}.` : ""}

Thanks,

${owner}${phone ? "\n" + phone : ""}${email ? "\n" + email : ""}`;

    const from = `${fromName || "BlacktopIQ"} <estimates@blacktopiq.com>`;
    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [toName ? `${toName} <${toEmail}>` : toEmail],
          subject: subject || `Your Estimate from ${fromName || "Us"}`,
          text: emailBody,
          attachments: [{ filename: pdfFilename || "Estimate.pdf", content: pdfBase64 }],
        }),
      });
      const emailData = await emailRes.json();
      if (!emailRes.ok) return res.status(500).json({ error: emailData.message || "Failed to send email." });
      return res.status(200).json({ success: true, emailId: emailData.id });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST send-feedback-reply (platform admin only) ───────────────────────
  if (action === "send-feedback-reply") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(500).json({ error: "RESEND_API_KEY not configured." });
    if (!serviceKey) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY." });

    const replysbH = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };

    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Missing auth token." });

    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": serviceKey, "Authorization": "Bearer " + token },
    });
    if (!userRes.ok) return res.status(401).json({ error: "Session expired." });
    const userData = await userRes.json();
    const callerId = userData?.id;

    // Verify platform admin
    const adminRes = await fetch(SUPABASE_URL + "/rest/v1/platform_admins?user_id=eq." + callerId + "&select=user_id", { headers: replysbH });
    const adminData = await adminRes.json();
    if (!Array.isArray(adminData) || adminData.length === 0) return res.status(403).json({ error: "Platform admins only." });

    const { feedbackId, userId, replyBody, feedbackType, feedbackTitle, feedbackBody } = req.body || {};
    if (!userId || !replyBody) return res.status(400).json({ error: "userId and replyBody required." });

    const profileRes = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + userId + "&select=email,first_name,last_name", { headers: replysbH });
    const profileData = await profileRes.json();
    const profile = Array.isArray(profileData) && profileData[0];
    if (!profile?.email) return res.status(400).json({ error: "Could not find user email." });

    const userName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email;
    const typeLabels = { bug:"Bug Report", feature:"Feature Request", question:"General Question", billing:"Billing Issue" };
    const emailBody = `Hi ${userName},

${replyBody}

---
Your original ${typeLabels[feedbackType]||"Feedback"}:

Subject: ${feedbackTitle}

${feedbackBody}

---
BlacktopIQ Support
help@blacktopiq.com`;

    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          from:    "BlacktopIQ Support <help@blacktopiq.com>",
          to:      [`${userName} <${profile.email}>`],
          subject: `Re: ${feedbackTitle}`,
          text:    emailBody,
        }),
      });
      const emailData = await emailRes.json();
      if (!emailRes.ok) return res.status(500).json({ error: emailData.message || "Failed to send." });

      // Auto-update status to in_progress
      if (feedbackId) {
        await fetch(SUPABASE_URL + "/rest/v1/feedback?id=eq." + feedbackId, {
          method: "PATCH",
          headers: { ...replysbH, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "in_progress" }),
        });
      }
      return res.status(200).json({ success: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: "Unknown action: " + action });
}
