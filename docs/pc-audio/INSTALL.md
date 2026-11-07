# Install Nuvio Legacy PC Audio

This alpha needs an LG webOS TV and a Windows PC on the same local network. Keep the PC awake for unsupported-audio playback. Supported audio can play directly without it.

## 1. Prepare the PC

1. Install an LTS version of [Node.js](https://nodejs.org/en/download), version 22 or newer.
2. Install a Windows FFmpeg build using the Windows links on the [FFmpeg download page](https://ffmpeg.org/download.html). Put its `bin` folder on your Windows PATH; both `ffmpeg.exe` and `ffprobe.exe` are needed.
3. Open a new terminal and check `node --version`, `ffmpeg -version` and `ffprobe -version`. All three must run.
4. Download `Nuvio-PC-Audio-Companion-0.2.1.zip` from [this fork's alpha release](https://github.com/ozggit/nuvio-native-legacy/releases/tag/pc-audio-2.0.85-alpha.1). Extract it to a folder you can write to. Keep all its files together.
5. Double-click `Start.cmd`. It starts the server in the background and opens **http://127.0.0.1:8788** on the PC. No `npm install` is needed.

The current ZIP is not a standalone EXE and does not bundle Node or FFmpeg. `Stop.cmd` shuts down the companion. Closing the browser tab does not stop it; the page's **Stop conversion** button stops only the current playback session.

If Windows blocks the TV connection, open an Administrator PowerShell in the extracted folder and run `.\Allow-TV.ps1`. It adds a Node-specific inbound TCP 8787 rule restricted to the local subnet. The setup page on 8788 remains PC-only. Do not forward either port through your router.

## 2. Install the TV app manually

1. Set up Developer Mode on your LG and connect it in [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop). Follow that project's device setup guidance.
2. Download `space.nuvio.native.legacy.pcaudio_2.0.85_arm.ipk` from the same alpha release.
3. Use Dev Manager to install the IPK, then open **Nuvio Legacy PC Audio** on the TV. Look for the large **PC AUDIO** label and amber computer/sound symbol.
4. Sign in and use your normal Nuvio add-ons/sources.

The app ID is `space.nuvio.native.legacy.pcaudio`. It is separate from the original Nuvio Legacy app. If updating an earlier PC Audio build, install over it rather than uninstalling first, to retain local data. Follow Developer Mode's renewal requirements to keep sideloaded apps available.

## 3. Pair with four digits

1. On the PC's companion page, select **Show pairing code**. If necessary, expand **Network settings** and choose the PC's correct Wi-Fi/LAN address.
2. On the TV, open **Settings → Playback → More options** (or enable Advanced). Under this TV's sound/video options, select **Pair PC audio server** and press OK.
3. Enter the four digits, including a leading zero if shown, and select **Done**. Stay in settings until pairing is confirmed.
4. Enable **PC audio fallback (experimental)** and open your stream normally.

Codes expire after two minutes, work once, and lock after five wrong attempts. Generate a new code to retry. The PC advertises discovery on UDP 8789 while the code is open; no inbound UDP rule is needed on the PC. Guest Wi-Fi, client isolation or separate subnets can block discovery.

## 4. Watch or choose another source

For DTS/DTS-HD/TrueHD/MLP, the PC selects English main audio and converts it to Dolby Digital AC-3 while copying H.264/HEVC video. If the TV shows video but no audio tracks, fallback can start after a three-second grace period following video loading. Probing and buffering then take additional time.

The TV shows **PC audio fallback**, its preparation/loading stage, and **Back - cancel and choose another stream**. Back stops that session and opens the source list. Enabling PC fallback gives it priority over the TV's local DTS converter; disabling it restores the original local behavior.

For a 5.1 source, check the TV's audio information and your soundbar/AVR's input format. Stereo sources stay stereo. Data sent on the companion page proves a connection, not the soundbar's output format.

## Troubleshooting

| Symptom | Check |
|---|---|
| `Start.cmd` cannot find a program | Open a new terminal and verify Node, FFmpeg and FFprobe on PATH. |
| Pairing times out | Same LAN, correct PC address, fresh four-digit code, TCP 8787 allowed, no guest/client isolation. |
| Pairing succeeded but PC stays idle | Enable PC fallback and use this PC AUDIO TV app. Supported streams correctly leave the PC idle. |
| TV picture but no audio tracks | Use TV app 2.0.83 or newer; earlier builds did not detect this case. Check the companion for an error after fallback starts. |
| PC unavailable after an IP address change | Select the new PC address and pair again. |
| A source cannot be inspected | Try another available source and check required headers/expiry. Report the error text without sharing its private URL. |
| Need to stop waiting | Press Back during PC loading to cancel and select another stream. |

## Update, privacy and rollback

Updates are manual downloads from [this fork's Releases](https://github.com/ozggit/nuvio-native-legacy/releases). The built-in updater is disabled for this separate alpha app. Pairing should survive an in-place TV update.

When updating the companion, stop it, copy new program files into its existing folder, preserve its private `data` folder, and restart it. The 0.2.1 change is cosmetic; a working 0.2.0 companion remains compatible with TV app 2.0.85.

Never upload `data/config.json`, the complete `data` folder, pairing keys, signed source URLs, or account tokens in an issue. Use the companion only on a trusted local network. Its setup page is available only on the PC.

To roll back, exit the PC Audio app and open the unchanged original Legacy app. You can also disable PC fallback in the test app. Report issues through [this fork's issue form](https://github.com/ozggit/nuvio-native-legacy/issues/new/choose).
