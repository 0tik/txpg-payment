# TXPG Payment Link Generator

Merchant UI for generating TXPG payment links via SOAP API. Deployable to Railway in one click.

## Features
- Enter amount + description → get a ready-to-share payment URL
- Currency selector (GEL / USD / EUR)
- One-click copy button
- Recent links history (stored in browser)
- Full mTLS client certificate support

---

## Certificate Setup (Required)

TXPG uses **mutual TLS** — the gateway only accepts connections from clients presenting a valid certificate issued by the bank.

### Step 1: Generate your certificate request
Run `request.bat` (provided by the bank). Fill in the fields:
- **Country**: GE
- **State**: Georgia
- **City**: Tbilisi (or your city)
- **Organization**: Your company name
- **Common Name**: your domain without www (e.g. `myshop.ge`)
- **Password**: leave empty (press Enter) — a password here can cause integration issues

This produces two files:
- `client.key` — your private key (keep this secret, never commit to git)
- `client.req` — certificate request to send to the bank

### Step 2: Send to the bank
Email `client.req` to the bank's processing department. They sign it and return `client.cer`.

### Step 3: Add to the app

**For Railway / cloud (recommended):**
```bash
# On Linux/Mac:
base64 -w0 client.key   # copy the output → CERT_KEY_B64
base64 -w0 client.cer   # copy the output → CERT_CRT_B64
```
Paste those values as environment variables in Railway.

**For local dev (file paths):**
```
mkdir certs
cp client.key certs/
cp client.cer certs/
```
Then set in `.env`:
```
CERT_KEY_PATH=./certs/client.key
CERT_CRT_PATH=./certs/client.cer
```

> ⚠️ Add `certs/` to `.gitignore`. Never commit your private key.

---

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Set environment variables (see below)
4. Deploy

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `TXPG_BASE_URL` | Gateway base URL | `https://libertypaytxtest.lb.ge:6443` |
| `TXPG_EXEC_PATH` | SOAP endpoint path | `/Exec` |
| `TXPG_PAY_PAGE` | Payment page base URL | `https://libertypaytxtest.lb.ge/twpga` |
| `MERCHANT_ID` | Your merchant ID | `IA00007A` |
| `DEFAULT_CURRENCY` | Default currency code | `981` (GEL) |
| `APPROVE_URL` | Redirect on success | — |
| `CANCEL_URL` | Redirect on cancel | — |
| `DECLINE_URL` | Redirect on decline | — |
| `CERT_KEY_B64` | Base64 of `client.key` | — |
| `CERT_CRT_B64` | Base64 of `client.cer` | — |
| `CERT_CA_B64` | Base64 of bank CA cert (if needed) | — |
| `CERT_KEY_PATH` | Path to `client.key` file | — |
| `CERT_CRT_PATH` | Path to `client.cer` file | — |
| `CERT_REJECT_UNAUTHORIZED` | Set `false` for test gateway only | `true` |

## Run Locally

```bash
npm install
cp .env.example .env   # fill in your values
node server.js
# → http://localhost:3000
```

## API

`POST /api/create-order`

```json
{
  "amount": 25.00,
  "currency": "981",
  "description": "Invoice #1234",
  "language": "EN"
}
```

Returns:
```json
{
  "paymentUrl": "https://libertypaytxtest.lb.ge/twpga?id=1718&password=alaoznssnmkg",
  "orderId": "1718",
  "sessionId": "alaoznssnmkg",
  "status": "00"
}
```

## Notes
- Amount is entered in major units (e.g. `25.00` GEL) — the server converts to minor units (tetri) automatically
- The gateway uses SOAP/XML; this app handles conversion transparently
- `CERT_REJECT_UNAUTHORIZED=false` only for the bank's test sandbox — always `true` in production
