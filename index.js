require("dotenv").config();

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require("plaid");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get("/api/healthz", (req, res) => {
  res.json({ status: "ok" });
});

// ─────────────────────────────────────────────
// Gmail helpers
// ─────────────────────────────────────────────
function getOAuth2Client(overrideRedirectUri) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri =
    overrideRedirectUri ||
    process.env.GMAIL_REDIRECT_URI ||
    "urn:ietf:wg:oauth:2.0:oob";

  if (!clientId || !clientSecret) {
    throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// POST /api/gmail/token
app.post("/api/gmail/token", async (req, res) => {
  const { code, redirectUri } = req.body;

  if (!code) {
    return res.status(400).json({ error: "code is required" });
  }

  try {
    const client = getOAuth2Client(redirectUri);
    const { tokens } = await client.getToken(code);
    res.json({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiry: tokens.expiry_date,
    });
  } catch (err) {
    console.error("gmail token exchange failed", err);
    res.status(502).json({ error: "Failed to exchange Gmail token" });
  }
});

// POST /api/gmail/scan
app.post("/api/gmail/scan", async (req, res) => {
  const { accessToken } = req.body;

  if (!accessToken) {
    return res.status(400).json({ error: "accessToken is required" });
  }

  try {
    const client = getOAuth2Client();
    client.setCredentials({ access_token: accessToken });

    const gmail = google.gmail({ version: "v1", auth: client });

    const searchQuery = [
      'subject:(subscription OR receipt OR "your order" OR "payment confirmation" OR renewal OR invoice)',
      "newer_than:180d",
    ].join(" ");

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: searchQuery,
      maxResults: 80,
    });

    const messageIds = listRes.data.messages || [];
    const parsed = [];
    const seen = new Set();

    await Promise.allSettled(
      messageIds.slice(0, 50).map(async (msg) => {
        if (!msg.id) return;

        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        });

        const headers = detail.data.payload?.headers || [];
        const get = (name) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
            ?.value || "";

        const subject = get("Subject");
        const from = get("From");
        const date = get("Date");

        const fromMatch = from.match(/^"?([^"<]+)"?\s*</);
        const company = fromMatch
          ? fromMatch[1].trim()
          : from.split("@")[0].trim();

        const amountMatch = subject.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
        const amount = amountMatch ? parseFloat(amountMatch[1]) : null;

        const key = company.toLowerCase().replace(/\s+/g, "");
        if (seen.has(key)) return;
        seen.add(key);

        const lowerSubject = subject.toLowerCase();
        const isSubscription =
          lowerSubject.includes("subscription") ||
          lowerSubject.includes("receipt") ||
          lowerSubject.includes("renewal") ||
          lowerSubject.includes("invoice") ||
          lowerSubject.includes("payment") ||
          lowerSubject.includes("charged") ||
          lowerSubject.includes("billing");

        if (isSubscription) {
          parsed.push({ name: company, amount, sender: from, date });
        }
      })
    );

    res.json({ subscriptions: parsed, emailCount: messageIds.length });
  } catch (err) {
    console.error("gmail scan failed", err);
    res.status(502).json({ error: "Failed to scan Gmail" });
  }
});

// ─────────────────────────────────────────────
// Plaid helpers
// ─────────────────────────────────────────────
function getPlaidClient() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || "sandbox";

  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID and PLAID_SECRET must be set");
  }

  const basePath = PlaidEnvironments[env] || PlaidEnvironments.sandbox;

  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });

  return new PlaidApi(config);
}

// POST /api/plaid/create-link-token
app.post("/api/plaid/create-link-token", async (req, res) => {
  const { userId } = req.body;

  try {
    const client = getPlaidClient();
    const response = await client.linkTokenCreate({
      user: { client_user_id: userId || "cleartab-user" },
      client_name: "ClearTab",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us, CountryCode.Gb],
      language: "en",
    });
    res.json({ linkToken: response.data.link_token });
  } catch (err) {
    console.error("plaid link token creation failed", err);
    res.status(502).json({ error: "Failed to create Plaid link token" });
  }
});

// POST /api/plaid/exchange-token
app.post("/api/plaid/exchange-token", async (req, res) => {
  const { publicToken } = req.body;

  if (!publicToken) {
    return res.status(400).json({ error: "publicToken is required" });
  }

  try {
    const client = getPlaidClient();

    const exchangeRes = await client.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = exchangeRes.data.access_token;

    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const txRes = await client.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 500 },
    });

    const transactions = txRes.data.transactions;
    const byMerchant = new Map();

    for (const tx of transactions) {
      const name = tx.merchant_name || tx.name;
      const key = name.toLowerCase().replace(/\s+/g, "");
      const category =
        tx.personal_finance_category?.primary || tx.category?.[0] || "Other";

      if (byMerchant.has(key)) {
        byMerchant.get(key).amounts.push(Math.abs(tx.amount));
        byMerchant.get(key).dates.push(tx.date);
      } else {
        byMerchant.set(key, {
          name,
          amounts: [Math.abs(tx.amount)],
          dates: [tx.date],
          category,
        });
      }
    }

    const recurring = [];
    for (const [, entry] of byMerchant) {
      if (entry.amounts.length < 2) continue;

      const sorted = [...entry.amounts].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      const sortedDates = [...entry.dates].sort();
      const firstDate = new Date(sortedDates[0]);
      const lastDate = new Date(sortedDates[sortedDates.length - 1]);
      const daySpan =
        (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24);
      const avgDays = daySpan / (entry.amounts.length - 1);

      const frequency =
        avgDays < 10
          ? "weekly"
          : avgDays < 35
          ? "monthly"
          : avgDays < 100
          ? "quarterly"
          : "annual";

      recurring.push({
        name: entry.name,
        amount: Math.round(median * 100) / 100,
        frequency,
        category: entry.category,
        occurrences: entry.amounts.length,
        lastCharge: sortedDates[sortedDates.length - 1],
      });
    }

    res.json({ recurring });
  } catch (err) {
    console.error("plaid exchange token failed", err);
    res.status(502).json({ error: "Failed to process Plaid token" });
  }
});

// ─────────────────────────────────────────────
// Cancellation email
// ─────────────────────────────────────────────
const SUPPORT_ADDRESSES = {
  netflix: "info@account.netflix.com",
  spotify: "support@spotify.com",
  adobe: "support@adobe.com",
  hulu: "support@hulu.com",
  amazon: "cs-reply@amazon.com",
  apple: "support@apple.com",
  google: "support@google.com",
  dropbox: "support@dropbox.com",
  microsoft: "support@microsoft.com",
  linkedin: "support@linkedin.com",
};

function getTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass },
  });
}

function findSupportEmail(name) {
  const lower = name.toLowerCase();
  for (const [key, email] of Object.entries(SUPPORT_ADDRESSES)) {
    if (lower.includes(key)) return email;
  }
  return "";
}

function buildEmail(subscriptionName, userEmail) {
  const subject = `Cancellation Request — ${subscriptionName} Account`;
  const text = `Hello ${subscriptionName} Support Team,

I am writing to request the immediate cancellation of my ${subscriptionName} subscription associated with the email address: ${userEmail}

Please confirm:
1. That my subscription has been cancelled effective immediately
2. That no further charges will be made to my payment method
3. That I will receive a confirmation email once the cancellation is processed

If there is any information you require to process this request, please contact me at the email address above.

Thank you for your assistance.

Best regards,
${userEmail}

---
This cancellation request was sent via ClearTab (cleartab.app).`;

  const html = `<p>Hello <strong>${subscriptionName}</strong> Support Team,</p>
<p>I am writing to request the immediate cancellation of my <strong>${subscriptionName}</strong> subscription associated with the email address: <strong>${userEmail}</strong></p>
<p>Please confirm:</p>
<ol>
  <li>That my subscription has been cancelled effective immediately</li>
  <li>That no further charges will be made to my payment method</li>
  <li>That I will receive a confirmation email once the cancellation is processed</li>
</ol>
<p>Thank you for your assistance.</p>
<p>Best regards,<br/>${userEmail}</p>
<hr/>
<small>This cancellation request was sent via <a href="https://cleartab.app">ClearTab</a>.</small>`;

  return { subject, text, html };
}

// POST /api/cancel/email
app.post("/api/cancel/email", async (req, res) => {
  const { subscriptionName, userEmail } = req.body;

  if (!subscriptionName || !userEmail) {
    return res
      .status(400)
      .json({ error: "subscriptionName and userEmail are required" });
  }

  const supportEmail = findSupportEmail(subscriptionName);
  const { subject, text, html } = buildEmail(subscriptionName, userEmail);
  const transport = getTransport();

  if (!transport) {
    return res.json({
      success: true,
      mock: true,
      message: "SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS to send real emails.",
      draft: { to: supportEmail || userEmail, subject, body: text },
    });
  }

  try {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    const to = supportEmail || userEmail;
    await transport.sendMail({ from, to, replyTo: userEmail, subject, text, html });
    console.log(`cancellation email sent to ${to}`);
    res.json({ success: true, mock: false, message: `Cancellation email sent to ${to}`, sentTo: to });
  } catch (err) {
    console.error("failed to send cancellation email", err);
    res.status(502).json({ error: "Failed to send cancellation email" });
  }
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ClearTab backend running on port ${PORT}`);
});
