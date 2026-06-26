// Proxies requests to the U.S. Census Bureau geocoder.
//
// Why this exists: the Census geocoder (geocoding.geo.census.gov) doesn't
// send CORS headers, so calling it directly from browser JS fails with a
// generic network error — the browser blocks the response before any JS
// on the page can read it. A serverless function calling it server-to-server
// has no such restriction, so we proxy through here instead.
//
// Deploy location: /api/geocode-census.js (Vercel auto-detects this as a
// serverless function at the path /api/geocode-census).

export default async function handler(req, res) {
  const address = req.query.address;
  if (!address || !String(address).trim()) {
    res.status(400).json({ error: "Missing 'address' query parameter" });
    return;
  }

  try {
    const url =
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" +
      encodeURIComponent(address);
    const censusRes = await fetch(url);
    const data = await censusRes.json();

    // Allow the app's own frontend to read this — same-origin in production,
    // but explicit is safer than relying on default behavior.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(censusRes.ok ? 200 : censusRes.status).json(data);
  } catch (e) {
    res.status(502).json({ error: "Census geocoder request failed", detail: String(e && e.message || e) });
  }
}
