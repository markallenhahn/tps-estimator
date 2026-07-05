import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  solo:      { monthly: "price_1TpJAdKfSm6pYdHi3tAAZ07N", yearly: "price_1TpJBFKfSm6pYdHiLzGdJvuw" },
  soloplus:  { monthly: "price_1TpJBrKfSm6pYdHilGpTbrpW", yearly: "price_1TpJC8KfSm6pYdHigREZLf5g" },
  crew:      { monthly: "price_1ToHMCKfSm6pYdHigCl0Soif", yearly: "price_1TpJ9hKfSm6pYdHipY1Mq2qO" },
  crewplus:  { monthly: "price_1TpJD3KfSm6pYdHiZnddwVDw", yearly: "price_1TpJDHKfSm6pYdHi2x3kXSYt" },
  pro:       { monthly: "price_1TpJERKfSm6pYdHiVvCQkBRr", yearly: "price_1TpJEjKfSm6pYdHiO741CXdn" },
};

const ALLOWED_ORIGINS = [
  "https://blacktopiq.com",
  "https://www.blacktopiq.com",
  "https://blacktopiq-www.vercel.app",
  "https://tps-estimator.vercel.app",
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { plan, interval } = req.body;

  if (!plan || !interval) {
    return res.status(400).json({ error: "Missing plan or interval" });
  }

  const priceId = PRICE_IDS[plan]?.[interval];
  if (!priceId) {
    return res.status(400).json({ error: `Unknown plan/interval: ${plan}/${interval}` });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://blacktopiq.com/success",
      cancel_url:  "https://blacktopiq.com/#pricing",
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[create-checkout]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
