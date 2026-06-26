# Veil for macOS

Veil is one cross-platform Electron app — the **same `src/` code** runs on Windows and macOS. There is no separate Mac codebase to keep in sync. macOS support is added purely through build config (`package.json` `build.mac`, `build/entitlements.mac.plist`, `build/icon-mac.png`) and a CI builder. **None of this changes the Windows build.**

## Getting the `.dmg` (no terminal)
A Mac app can only be built on a Mac, so we build it in the cloud:

1. Go to the repo on GitHub → **Actions** tab.
2. Pick **"Build macOS app"** in the left list → click **"Run workflow"** → **Run workflow**.
3. Wait ~5 minutes. When it's green:
   - Download the `.dmg` from the run's **Artifacts** ("Veil-macOS-dmg"), and
   - it's also attached to the **v0.1.0 Release** (next to the Windows installer).

It builds a single **universal** dmg (`Veil-<version>-mac.dmg`) that runs on **both Apple Silicon and Intel** Macs — no need to pick.

## Installing (first time)
The build is **unsigned** for now (no Apple Developer account yet), so macOS Gatekeeper will say *"Veil can't be opened because Apple cannot check it…"*. To open it:

- **Right-click** the Veil app → **Open** → **Open** in the dialog. (Only needed the first time.)
- If that's blocked: **System Settings → Privacy & Security**, scroll down, click **"Open Anyway"** next to Veil.

## First-run permissions to grant (System Settings → Privacy & Security)
macOS will ask for these the first time each feature is used:

- **Screen Recording** — required for **"Read my screen" (Cmd+Enter)**. If your first screenshot looks blank, enable Veil under **Privacy & Security → Screen Recording**, then **quit and reopen Veil** (macOS requires a restart after granting this one).
- **Microphone** — for **Listen mode** and the **Practice** voice answers.
- **Camera** — only for the optional **Practice** interview self-view.

The invisibility (hidden from screen share) works on macOS the same way as Windows via content protection.

## Known macOS limitation: Listen mode = your mic only
On macOS, the browser/OS does **not** allow capturing the *other person's* call audio through `getDisplayMedia` (this is an Apple restriction, not a Veil bug). So on Mac, Listen mode transcribes **your microphone** by default. To also capture the call's audio, either:

- install a free virtual audio device like **BlackHole** and route your call audio into it (advanced), or
- wait for the planned **ScreenCaptureKit** system-audio capture (a future Mac enhancement).

On Windows, Listen captures system + mic as usual — unchanged.

## Removing the Gatekeeper warning (the only real fix = notarization)
The "Apple could not verify Veil…" warning only goes away if the app is **signed with an Apple Developer ID cert and notarized by Apple**. That requires the paid **Apple Developer Program ($99/yr)** — there is no free path.

**You do (one-time, ~30 min):**
1. Enroll at <https://developer.apple.com/programs/> ($99/yr).
2. In the Apple Developer site → Certificates → create a **"Developer ID Application"** certificate, then export it from Keychain as a **.p12** with a password.
3. Create an **app-specific password** at <https://account.apple.com> (Sign-In & Security → App-Specific Passwords) for notarization.
4. Note your **Team ID** (Apple Developer → Membership).
5. In the GitHub repo → Settings → Secrets and variables → Actions, add: `MAC_CERT_P12` (base64 of the .p12), `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

**I do (once the secrets exist):** update `.github/workflows/build-mac.yml` to import the cert and notarize during the build, plus `build.mac.notarize` in `package.json`. After that every `.dmg` opens with no warning. Same idea as Azure Trusted Signing on Windows.
