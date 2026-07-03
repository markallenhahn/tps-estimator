// api/submit-request.js
// Public endpoint — no auth required.
// Accepts an estimate request from the public form, creates a job in Supabase,
// and uploads any photos to the estimate-requests storage bucket.
//
// The created job has:
//   status: "estimate"
//   source: "request_form"
//   clientName, clientPhone, clientEmail, address, city, state, zip
//   notes: services selected + client description
//   areas: empty (estimator fills in measurements)

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const {
    tenantId, name, phone, email,
    address, city, state, zip,
    services, notes, photos,
  } = req.body || {};

  // Basic validation
  if (!tenantId) return res.status(400).json({ error: "Missing tenant ID" });
  if (!name?.trim()) return res.status(400).json({ error: "Name is required" });
  if (!phone?.trim() && !email?.trim()) return res.status(400).json({ error: "Phone or email required" });
  if (!address?.trim()) return res.status(400).json({ error: "Address is required" });
  if (!services?.length) return res.status(400).json({ error: "At least one service is required" });

  const sbH = {
    "apikey": serviceKey,
    "Authorization": "Bearer " + serviceKey,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };

  // Upload photos to Supabase Storage
  const photoUrls = [];
  if (Array.isArray(photos) && photos.length > 0) {
    for (const photo of photos.slice(0, 5)) {
      try {
        if (!photo.dataUrl) continue;
        // Convert base64 data URL to buffer
        const base64 = photo.dataUrl.split(",")[1];
        const buffer = Buffer.from(base64, "base64");
        const ext    = photo.name?.split(".").pop()?.toLowerCase() || "jpg";
        const path   = `${tenantId}/requests/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const upRes  = await fetch(
          SUPABASE_URL + "/storage/v1/object/estimate-requests/" + path,
          {
            method:  "POST",
            headers: {
              "apikey":        serviceKey,
              "Authorization": "Bearer " + serviceKey,
              "Content-Type":  "image/" + ext,
            },
            body: buffer,
          }
        );
        if (upRes.ok) {
          photoUrls.push(SUPABASE_URL + "/storage/v1/object/public/estimate-requests/" + path);
        }
      } catch(e) { /* non-fatal — skip bad photo */ }
    }
  }

  // Build job notes combining services + client description + photos
  const servicesLine = "Services requested: " + services.join(", ");
  const notesLine    = notes?.trim() ? "\n\nClient notes: " + notes.trim() : "";
  const sourceLine   = "\n\n[Submitted via estimate request form]";
  const photosLine   = photoUrls.length > 0 ? "\n\nPhotos:\n" + photoUrls.join("\n") : "";
  const fullNotes    = servicesLine + notesLine + photosLine + sourceLine;

  // Build job address
  const fullAddress = [address, city, state, zip].filter(Boolean).join(", ");

  // Create job row
  const jobId = Date.now();
  const job = {
    id:           jobId,
    tenant_id:    tenantId,
    data: {
      id:           jobId,
      clientName:   name.trim(),
      clientPhone:  phone?.trim() || "",
      clientEmail:  email?.trim() || "",
      address:      address.trim(),
      city:         city?.trim()  || "",
      state:        state?.trim() || "",
      zip:          zip?.trim()   || "",
      fullAddress,
      status:       "estimate",
      source:       "request_form",
      estimateNum:  (() => {
        const now = new Date();
        const mm  = String(now.getMonth()+1).padStart(2,"0");
        const dd  = String(now.getDate()).padStart(2,"0");
        return `EST-${mm}${dd}-001`;  // seq starts at 001 for request form jobs
      })(),
      date:         new Date().toISOString().slice(0, 10),
      notes:        fullNotes,
      areas:        [],
      photoUrls,
      readyForReview: false,
      statusChangedAt: new Date().toISOString(),
    },
  };

  const jobRes = await fetch(SUPABASE_URL + "/rest/v1/jobs", {
    method:  "POST",
    headers: sbH,
    body:    JSON.stringify(job),
  });

  if (!jobRes.ok) {
    const err = await jobRes.text();
    console.error("[submit-request] job insert failed:", err);
    return res.status(500).json({ error: "Failed to submit request. Please try again." });
  }

  return res.status(200).json({ success: true, jobId });
}
