import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM = "BlacktopIQ <noreply@blacktopiq.com>";
const APP_URL = "https://blacktopiq.com";

const sendEmail = async (to: string, subject: string, html: string) => {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
  return res.json();
};

const buttonStyle = `
  display: inline-block;
  background: #f0ab2e;
  color: #000000;
  font-weight: 700;
  font-size: 15px;
  padding: 12px 28px;
  border-radius: 6px;
  text-decoration: none;
  margin: 20px 0;
`;

const wrapEmail = (body: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#111111;padding:24px 32px;">
            <span style="color:#f0ab2e;font-size:22px;font-weight:800;letter-spacing:-0.5px;">BlacktopIQ</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="background:#f4f4f5;padding:20px 32px;font-size:12px;color:#888;">
            © ${new Date().getFullYear()} BlacktopIQ. If you didn't request this email, you can safely ignore it.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // Log raw payload so we can see the exact structure Supabase sends
    const payload = await req.json();
    console.log("Raw hook payload:", JSON.stringify(payload, null, 2));

    // Supabase auth hook payload shape (v2):
    // { user: { email, ... }, email_data: { token, token_hash, redirect_to, email_action_type, site_url } }
    // OR older shape:
    // { type, email, data: { token, token_hash, ... } }

    // Handle both payload shapes
    const email = payload?.user?.email || payload?.email;
    const emailData = payload?.email_data || payload?.data || {};
    const type = payload?.email_data?.email_action_type || payload?.type;
    const tokenHash = emailData?.token_hash;
    const token = emailData?.token;
    const redirectTo = emailData?.redirect_to || emailData?.site_url || APP_URL;

    console.log("Parsed:", { email, type, tokenHash, token, redirectTo });

    if (!email) {
      throw new Error("No email found in payload: " + JSON.stringify(payload));
    }

    // Build action URL
    const actionUrl = tokenHash
      ? `${redirectTo}?token_hash=${tokenHash}&type=${type}`
      : token
      ? `${redirectTo}?token=${token}&type=${type}`
      : redirectTo;

    let subject = "";
    let html = "";

    if (type === "signup" || type === "email_confirmation") {
      subject = "Confirm your BlacktopIQ account";
      html = wrapEmail(`
        <h2 style="margin:0 0 8px;font-size:22px;color:#111;">Welcome to BlacktopIQ!</h2>
        <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 16px;">
          Thanks for signing up. Click the button below to confirm your email address and activate your account.
        </p>
        <a href="${actionUrl}" style="${buttonStyle}">Confirm Email</a>
        <p style="color:#888;font-size:13px;margin-top:16px;">
          This link expires in 24 hours. If you didn't create a BlacktopIQ account, you can safely ignore this email.
        </p>
      `);
    } else if (type === "recovery") {
      subject = "Reset your BlacktopIQ password";
      html = wrapEmail(`
        <h2 style="margin:0 0 8px;font-size:22px;color:#111;">Password Reset</h2>
        <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 16px;">
          We received a request to reset the password for your BlacktopIQ account. Click the button below to choose a new password.
        </p>
        <a href="${actionUrl}" style="${buttonStyle}">Reset Password</a>
        <p style="color:#888;font-size:13px;margin-top:16px;">
          This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
        </p>
      `);
    } else if (type === "invite" || type === "magiclink") {
      subject = "You've been invited to BlacktopIQ";
      html = wrapEmail(`
        <h2 style="margin:0 0 8px;font-size:22px;color:#111;">You're invited!</h2>
        <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 16px;">
          Your company owner has invited you to join their team on BlacktopIQ — the field management platform built for paving contractors.
        </p>
        <a href="${actionUrl}" style="${buttonStyle}">Accept Invitation</a>
        <p style="color:#888;font-size:13px;margin-top:16px;">
          This invitation expires in 7 days.
        </p>
      `);
    } else {
      console.log("Unhandled auth hook type:", type, "full payload:", JSON.stringify(payload));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    await sendEmail(email, subject, html);
    console.log("Email sent to", email, "type:", type);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-auth-email error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

