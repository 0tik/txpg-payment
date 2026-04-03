const express = require("express");
const axios = require("axios");
const https = require("https");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TXPG_BASE_URL    = process.env.TXPG_BASE_URL    || "https://libertypaytxtest.lb.ge:6443";
const TXPG_EXEC_PATH   = process.env.TXPG_EXEC_PATH   || "/Exec";
const TXPG_PAY_PAGE    = process.env.TXPG_PAY_PAGE    || "https://libertypaytxtest.lb.ge/twpga";
const MERCHANT_ID      = process.env.MERCHANT_ID      || "IA00007A";
const APPROVE_URL      = process.env.APPROVE_URL      || "https://libertypaytxtest.lb.ge/";
const CANCEL_URL       = process.env.CANCEL_URL       || "https://libertypaytxtest.lb.ge/";
const DECLINE_URL      = process.env.DECLINE_URL      || "https://libertypaytxtest.lb.ge/";
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "981";
const PORT             = process.env.PORT             || 3000;

// ─── Password Protection ──────────────────────────────────────────────────────
// Set UI_PASSWORD in env to enable. Leave unset for open access.
const UI_PASSWORD = process.env.UI_PASSWORD || null;

if (UI_PASSWORD) {
  console.log("[auth] Password protection enabled");
} else {
  console.log("[auth] No UI_PASSWORD set — open access");
}

// Simple in-memory session store: token → expiry timestamp
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
}

// Clean expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// Auth middleware
function requireAuth(req, res, next) {
  if (!UI_PASSWORD) return next();
  const token = req.headers["x-session-token"];
  if (isValidSession(token)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ─── Auth Endpoints ───────────────────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  if (!UI_PASSWORD) return res.json({ ok: true, token: null, passwordRequired: false });
  const { password } = req.body || {};
  const provided = Buffer.from(String(password || ""));
  const expected = Buffer.from(UI_PASSWORD);
  const match =
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);
  if (!match) return res.status(403).json({ error: "Incorrect password" });
  const token = createSession();
  res.json({ ok: true, token, passwordRequired: true });
});

app.post("/api/logout", (req, res) => {
  const token = req.headers["x-session-token"];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// Tell the frontend whether a password is required (no secret exposed)
app.get("/api/auth-status", (req, res) => {
  const token = req.headers["x-session-token"];
  res.json({
    passwordRequired: !!UI_PASSWORD,
    authenticated: !UI_PASSWORD || isValidSession(token),
  });
});

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── mTLS Certificate Loading ─────────────────────────────────────────────────
function loadCertMaterial() {
  function load(b64Var, pathVar, label) {
    if (process.env[b64Var]) {
      const buf = Buffer.from(process.env[b64Var], "base64");
      console.log(`[cert] Loaded ${label} from env var ${b64Var} (${buf.length} bytes)`);
      return buf;
    }
    if (process.env[pathVar]) {
      const p = process.env[pathVar];
      if (!fs.existsSync(p)) throw new Error(`[cert] ${label} file not found: ${p}`);
      const buf = fs.readFileSync(p);
      console.log(`[cert] Loaded ${label} from file ${p} (${buf.length} bytes)`);
      return buf;
    }
    return null;
  }

  const key  = load("CERT_KEY_B64", "CERT_KEY_PATH", "client.key");
  const cert = load("CERT_CRT_B64", "CERT_CRT_PATH", "client.cer");
  const ca   = load("CERT_CA_B64",  "CERT_CA_PATH",  "CA cert");

  if (!key || !cert) {
    console.warn(
      "[cert] WARNING: No client certificate configured.\n" +
      "       Set CERT_KEY_B64 + CERT_CRT_B64 (base64) or\n" +
      "       CERT_KEY_PATH + CERT_CRT_PATH (file paths).\n" +
      "       Falling back to no-cert mode (will fail on production gateway)."
    );
    return new https.Agent({ rejectUnauthorized: false });
  }

  const agentOptions = {
    key,
    cert,
    rejectUnauthorized: process.env.CERT_REJECT_UNAUTHORIZED !== "false",
  };
  if (ca) agentOptions.ca = ca;

  console.log("[cert] mTLS httpsAgent ready ✓");
  return new https.Agent(agentOptions);
}

const httpsAgent = loadCertMaterial();

// ─── Payment API ──────────────────────────────────────────────────────────────
app.post("/api/create-order", requireAuth, async (req, res) => {
  const {
    amount,
    currency = DEFAULT_CURRENCY,
    description = "Payment",
    language = "EN",
  } = req.body;

  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  const amountMinUnits = Math.round(Number(amount) * 100);

  const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<TKKPG>
  <Request>
    <Operation>CreateOrder</Operation>
    <Language>${language}</Language>
    <Order>
      <OrderType>Purchase</OrderType>
      <Merchant>${MERCHANT_ID}</Merchant>
      <Amount>${amountMinUnits}</Amount>
      <Currency>${currency}</Currency>
      <Description>${description}</Description>
      <ApproveURL>${APPROVE_URL}</ApproveURL>
      <CancelURL>${CANCEL_URL}</CancelURL>
      <DeclineURL>${DECLINE_URL}</DeclineURL>
      <AddParams></AddParams>
    </Order>
  </Request>
</TKKPG>`;

  try {
    const response = await axios.post(
      `${TXPG_BASE_URL}${TXPG_EXEC_PATH}`,
      soapBody,
      {
        headers: { "Content-Type": "application/xml" },
        httpsAgent,
        timeout: 15000,
      }
    );

    const xml = response.data;
    const status    = extractTag(xml, "Status");
    const orderId   = extractTag(xml, "OrderID");
    const sessionId = extractTag(xml, "SessionID");
    const urlFromResponse = extractTag(xml, "URL");

    if (status !== "00") {
      return res.status(502).json({ error: `Gateway returned status: ${status}`, raw: xml });
    }

    const basePayUrl = urlFromResponse || TXPG_PAY_PAGE;
    const paymentUrl = `${basePayUrl}?id=${orderId}&password=${sessionId}`;

    return res.json({ paymentUrl, orderId, sessionId, status });
  } catch (err) {
    console.error("TXPG error:", err.message);
    return res.status(502).json({ error: "Failed to connect to payment gateway", detail: err.message });
  }
});

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : null;
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`TXPG Payment Generator running on port ${PORT}`);
});
