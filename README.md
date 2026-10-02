*[Đọc bằng tiếng Việt](README.vi.md)*

# KysoQR 

PDF e-signing via QR code (CAS e-signing) and digital signature verification — open source, **a single, fully stateless Next.js application**.

**Try it live:** [kysoqr.com](https://kysoqr.com/) — no need to clone/install anything just to see how it works.

## What is KysoQR Opensource?

KysoQR is a digital signing and signature verification application, aiming to be an **open-source, self-hostable, minimal-setup** tool — running in just a few commands.

Once deployed, a business's signing process looks like this:

- Sign up on **Cas ID** (download from the App Store or Google Play) to register a personal digital signature (currently free) — see the step-by-step walkthrough below.
- Upload the document to the KysoQR app.
- Configure the signing session (signer and signature position) and click "Sign".
- Scan the QR code with Cas ID to complete the signing session.

### Registering a digital certificate on Cas ID

Cas ID has two separate guided flows depending on account type. Screenshots below are from Cas ID's own registration flow ([cas.so/cas-id/chu-ky-so](https://cas.so/cas-id/chu-ky-so/)).

#### Individual / Household business — 7 steps

![Cas ID individual/household-business registration walkthrough](public/cas-id-registration-individual.gif)

1. **Add a digital asset** — start the flow.
   - On the Cas ID home screen, tap the **[+]** icon to add a new link.
   - Select the **Individual / Household business** tab.
   - Tap **Add a digital asset**.
2. **Choose a service** — pick the service to connect.
   - The system shows a list of account/service types.
   - Find and select **Digital certificate**.
3. **Choose a plan** — pick a subscription plan.
   - On the "Add digital certificate" screen, tap **CLAIM NOW** on the promo banner.
   - Choose a suitable plan (e.g. 3-month plan — free, or a 1-year plan).
   - Agree to the terms of service, then tap **Continue**.
4. **Signature** — create your e-signature sample.
   - Draw or sign directly with your finger in the white box on screen.
   - Tap **Continue** to move to the next step.
5. **Identity verification** — confirm sharing identity information.
   - Review the personal info synced from eKYC: full name, ID number, address.
   - Check the box confirming you've read and understood the data-sharing purpose.
   - Tap **Confirm**.
6. **Payment** — pay for the plan.
   - On the payment details screen, enter a discount code if you have one, and review the unit price, tax, and total.
   - If you need a VAT invoice, turn on invoice issuance and fill in the recipient's details.
   - Tap **Complete order**, then pay via bank transfer or by scanning the QR code with your mobile banking app.
7. **Activation** — confirm certificate activation.
   - Review the certificate details: issuer, owner, serial number, expiry date.
   - Tap **Confirm activation now**.
   - The system shows "Activated successfully" — you're done.

#### Enterprise — 6 steps

![Cas ID enterprise registration walkthrough](public/cas-id-registration-enterprise.gif)

1. **Start** — initialize & choose a plan.
   - On the Cas ID home screen, tap **[+]** → select the **Enterprise** tab → **Add a digital asset**.
   - Select the business to register (or verify an additional business). The person performing this must be the business's legal representative.
   - Select **Digital certificate**, tap **Register now** on the Intrust banner, choose a plan, and tap **Continue**.
2. **Profile** — fill in the registration request.
   - Review the synced business info: tax code, name, address, tax-code status.
   - Upload the business license (PDF/DOCX/JPG/PNG, max 2MB) and enter an email to receive updates.
   - Agree to the data-use terms for certificate issuance and the Intrust CA Agreement, then **Confirm**.
3. **eKYC** — verify identity via eKYC.
   - Tap **Start**; photograph the front and back of your chip-based ID card within the on-screen frame.
   - Tap the back of your ID card against the NFC area, hold steady, then complete face verification.
   - Once the system reports a match, tap **Complete** to submit the request.
4. **Payment** — pay for the plan.
   - Once the application is approved, open the notification in Cas ID (status: awaiting payment).
   - Enter a discount code if you have one; issue a VAT invoice if needed.
   - Pay via bank transfer or by scanning a mobile-banking QR code.
5. **OTP & PIN** — activate & set your signing PIN.
   - Status changes to "awaiting activation" — tap **Continue**.
   - Enter the 6-digit OTP sent to the registered phone number.
   - Create a 6-digit signing PIN and re-enter it to confirm.
6. **Done** — registration complete.
   - The system shows "Registration successful."
   - The Intrust CA certificate is now linked to the business's profile in Cas ID and ready for remote digital signing.

## Why use this app to roll out digital signing for a business?

- **Roll out an internal signing system quickly and for free** — clone it, install dependencies, create `.env`, run one command and it works.

- **Verify most digitally-signed contracts in Vietnam** — uses the algorithm built into the app to check whether the signature on a contract was actually produced by the real private-key holder, not just by comparing a few self-reported fields.

- **Open source and transparent** — anyone can read and independently verify the verification logic, instead of trusting a black box.

- **Minimal infrastructure** — a signing/verification service that doesn't need to hold state server-side shouldn't force operators to stand up a whole DB + queue + cache stack just to run it.

## Architecture summary

Two independent flows in one repo, a fully stateless server (no file writes, no session held between requests):

- **Signing** (CAS-driven) — `POST /api/sign/request` sends the document + signature position to CAS → poll `GET /api/sign/status` → once complete, download the signed file via `GET /api/sign/download`. Signing-session state lives only in the browser's `localStorage`.
- **Verification** (document-driven) — `POST /api/verify/upload` performs real signature verification (signature + chain + trust anchor), fully independent of CAS/any database. `GET /api/verify/signing-round/[orgIdSigned]` is a convenience CAS lookup, not a replacement for verify-by-upload.
- CAS is abstracted behind a `CasProvider` interface, with one real implementation (`CasEsignProvider`) — it calls the CAS e-signing API directly; there is no mock mode.
- API reference: interactive at `/docs` when the app is running (OpenAPI files in [public/openapi/](public/openapi/)).

## What does the signer need to do?

KysoQR **does not sign documents itself** — the actual signing (holding the private key, HSM) happens at CAS. KysoQR only creates the signing request and hands it to the signer via the **Cas ID** app. From the signer's perspective, the flow is:

1. The requester (using KysoQR) uploads the PDF, places the signature field(s), and clicks "Sign".
2. KysoQR displays a QR code containing the newly created signing request.
3. The signer opens the **Cas ID** app on their phone (installed from the App Store/Google Play — search "Cas ID"), then either:
   - **Scans the QR code** shown on screen, or
   - If the requester already supplied the signer's national ID number in step 1, the signer instead gets a **push notification** directly in the Cas ID app — no scanning needed.
4. Inside the Cas ID app, the signer reviews the document and **approves the signing request**.
5. Once approved, CAS finishes signing (via HSM). KysoQR automatically detects this (polling status every 4 seconds) and lets the requester download the signed file and see the verification code (`orgIdSigned`).

## Running the project

### 1. Local — personal machine, development/testing

```bash
git clone https://github.com/KysoQR/KysoQR
cd KysoQR
npm install
cp .env.example .env
npm run dev
```

No database, Redis, or any external service needed — open `http://localhost:3000` and it's ready. The **signature verification** flow works immediately, no credentials needed. The **signing** flow needs `CAS_ESIGN_BASE_URL`/`CAS_ESIGN_CLIENT_ID`/`CAS_ESIGN_API_KEY` filled in `.env` first (no default is ever hardcoded in source — see the ["Environment variables you'll need"](#environment-variables-youll-need) section below if you want to try it right away with a shared demo key). The trusted root CAs used for signature verification aren't configured via env — they're bundled in [`lib/trustStore/roots/`](lib/trustStore/roots/README.md).

### 2. Server — self-hosted on your own machine/VPS

Fundamentally still a single Node.js process, no DB/Redis needed — the only difference from Local is running the production build instead of the dev server:

```bash
npm install
cp .env.example .env   # fill in the 3 real CAS_ESIGN_* variables
npm run build
npm run start
```

Recommended: put it behind a reverse proxy (Nginx/Caddy) for TLS; make sure `.env` is never exposed (file permissions, not served statically); don't log PII.

Detailed step-by-step guide (installing Node, systemd service, Nginx + TLS, updating code): [`docs/DEPLOY.md`](docs/DEPLOY.md).

### 3. Cloud Worker — serverless/edge platforms

The architecture is designed for this model from the start: a fully stateless server, no file writes or in-process state, all configuration read from the platform's environment variables/secrets.

Works **today** on any serverless/container platform with a full Node.js runtime (e.g. Vercel serverless functions in Node runtime mode, AWS Lambda container images, Fly.io Machines, Railway...) — set environment variables via that platform's secrets manager; operations are otherwise identical to the "Server" section above.

**Verified working on Cloudflare Workers** (a pure edge/isolate runtime with no real filesystem) via the OpenNext Cloudflare adapter (`nodejs_compat`, which lets `node-forge`/`Buffer` run). One important difference to know: `lib/trustStore/` (which reads CA certificates) also uses a manifest generated at build time (`lib/trustStore/generated/*.generated.ts`, see [`lib/trustStore/roots/README.md`](lib/trustStore/roots/README.md)) because Cloudflare Workers has no real filesystem to read from at runtime the way a VPS does. Detailed guide: [`docs/DEPLOY_CLOUDFLARE.md`](docs/DEPLOY_CLOUDFLARE.md).

## Commands

| Task       | Command              |
| ---------- | --------------------- |
| Dev server | `npm run dev`       |
| Build      | `npm run build`     |
| Test       | `npm test`          |
| Lint       | `npm run lint`      |
| Format     | `npm run format`    |
| Type-check | `npm run typecheck` |

## Contributing / working rules

Fixed rules for contributing code (Definition of Done, when to enable Plan Mode, the mandatory Verification Loop after every code change): [`Rule/RULES.md`](Rule/RULES.md). Required reading before writing any code.

## License

Licensed under the **MIT License** — see [`LICENSE`](LICENSE).

## Status

The project is under active development — both the signing flow and the signature-verification flow (CMS signature, certificate chain, AIA, OCSP/CRL) are fully working.

## Environment variables you'll need

```
NODE_ENV="production"
CAS_ESIGN_BASE_URL=https://production.bankhub.dev
CAS_ESIGN_CLIENT_ID=trial-vendor-47de-86e8-7342f311028c
CAS_ESIGN_API_KEY=a0e6d612-b34e-11f1-a10d-02cf4c5ff398
```

Note: these are shared **trial** keys meant for trying the app out right away. If you want to sign real documents daily or ship this as part of a production product, go to https://cas.so/ or call +84 961 580 977 to get your own key.
