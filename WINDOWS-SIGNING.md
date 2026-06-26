# Windows code signing (Azure Trusted Signing)

Goal: stop the **"Windows protected your PC" / SmartScreen** warning by signing the
installer with a Microsoft-trusted certificate. Cost: **~$9.99/mo** (Azure Trusted
Signing "Basic"). No per-certificate fee. This is the modern replacement for buying
an EV cert + USB token.

> Like Apple, there's a one-time **identity validation**. It's usually faster, but
> **start it first** — it's the long pole. Everything else is quick.

## Step 1 — Azure account + Trusted Signing (you)
1. Sign in / create an **Azure** account (pay-as-you-go): <https://portal.azure.com>.
2. Create a **Trusted Signing account** (search "Trusted Signing" in the portal → Create). Pick a region (e.g. East US) and the **Basic** plan.
3. Inside it, create a **Certificate Profile**:
   - **Public Trust** type (this is what removes the SmartScreen warning).
   - **Identity validation:** choose **Individual** if ExceedNorth is a newer business (validates *you* with a government ID — no business-history requirement). Choose **Organization** only if the business has the required verifiable history. *This is the step that takes time.*

## Step 2 — Service principal so the cloud builder can sign (you, ~5 min once Step 1 is approved)
1. Azure portal → **Microsoft Entra ID → App registrations → New registration** (name it "veil-signing"). Note the **Application (client) ID** and **Directory (tenant) ID**.
2. In that app → **Certificates & secrets → New client secret** → copy the **secret value**.
3. In your **Trusted Signing account → Access control (IAM) → Add role assignment** → role **"Trusted Signing Certificate Profile Signer"** → assign it to the "veil-signing" app.

## Step 3 — Add GitHub secrets (you)
Repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Where it comes from |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | the client secret value |
| `AZURE_ENDPOINT` | your region endpoint, e.g. `https://eus.codesigning.azure.net/` |
| `AZURE_ACCOUNT` | the Trusted Signing **account** name |
| `AZURE_PROFILE` | the **certificate profile** name |
| `AZURE_PUBLISHER_NAME` | the validated identity name (your name, or "ExceedNorth") — must match the cert |

## Step 4 — I flip it on
`.github/workflows/build-win.yml` already auto-detects these secrets: with them present it
builds a **signed** installer (Azure Trusted Signing); without them it builds unsigned as
today. Once the secrets are in, we run the workflow, confirm the installer is signed, and
the SmartScreen warning is gone (reputation builds quickly with a Trusted Signing cert).

> Note: I'll verify and, if needed, fine-tune the electron-builder Azure config the first
> time we build with your real credentials — the exact endpoint/profile values only exist
> once your account is set up.
