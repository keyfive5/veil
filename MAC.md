# Veil for macOS

Veil is one cross-platform Electron app — the **same `src/` code** runs on Windows and macOS. There is no separate Mac codebase to keep in sync. macOS support is added purely through build config (`package.json` `build.mac`, `build/entitlements.mac.plist`, `build/icon-mac.png`) and a CI builder. **None of this changes the Windows build.**

## Getting the `.dmg` (no terminal)
A Mac app can only be built on a Mac, so we build it in the cloud:

1. Go to the repo on GitHub → **Actions** tab.
2. Pick **"Build macOS app"** in the left list → click **"Run workflow"** → **Run workflow**.
3. Wait ~5 minutes. When it's green:
   - Download the `.dmg` from the run's **Artifacts** ("Veil-macOS-dmg"), and
   - it's also attached to the **v0.1.0 Release** (next to the Windows installer).

It builds both **Apple Silicon (arm64)** and **Intel (x64)** dmgs — use the one matching your Mac (arm64 for M1/M2/M3/M4).

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

## Later: remove the Gatekeeper warning
Once you have an **Apple Developer account ($99/yr)**, we add notarization to `.github/workflows/build-mac.yml` (Apple ID / app-specific password / Team ID stored as GitHub secrets). After that, the dmg opens with no warning — same idea as Azure Trusted Signing on Windows.
