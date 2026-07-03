// api/send-estimate-email.js
// Sends an estimate PDF to the client via Resend with the PDF as an attachment.

const SUPABASE_URL = "https://elzymtqlcceouftwhcdk.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const resendKey  = process.env.RESEND_API_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!resendKey)  return res.status(500).json({ error: "RESEND_API_KEY not configured." });
  if (!serviceKey) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY not configured." });

  // Auth check
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token." });

  const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { "apikey": serviceKey, "Authorization": "Bearer " + token },
  });
  if (!userRes.ok) return res.status(401).json({ error: "Session expired. Please sign in again." });

  const {
    toEmail,        // client email
    toName,         // client name
    subject,        // email subject
    body,           // plain text body
    pdfBase64,      // base64-encoded PDF
    pdfFilename,    // e.g. "TPS_Estimate_EST-0703-001.pdf"
    fromName,       // company name
    fromEmail,      // verified sending address (optional override)
  } = req.body || {};

  if (!toEmail) return res.status(400).json({ error: "Client email is required." });
  if (!pdfBase64) return res.status(400).json({ error: "PDF data is required." });

  const emailSubject = subject || `Your Estimate from ${fromName || "Us"}`;
  const emailBody    = body    || `Please find your estimate attached.\n\nThank you for your business!\n— ${fromName || ""}`;
  const filename     = pdfFilename || "Estimate.pdf";

  // Use verified Resend domain or fall back to onboarding@resend.dev for testing
  const from = fromEmail
    ? `${fromName || "BlacktopIQ"} <${fromEmail}>`
    : `${fromName || "BlacktopIQ"} <estimates@blacktopiq.com>`;

  try {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + resendKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [toName ? `${toName} <${toEmail}>` : toEmail],
        subject: emailSubject,
        text: emailBody,
        attachments: [
          {
            filename,
            content: pdfBase64,
          },
        ],
      }),
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      console.error("[send-estimate-email] Resend error:", emailData);
      return res.status(500).json({ error: emailData.message || "Failed to send email." });
    }

    return res.status(200).json({ success: true, emailId: emailData.id });
  } catch (e) {
    console.error("[send-estimate-email] error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
