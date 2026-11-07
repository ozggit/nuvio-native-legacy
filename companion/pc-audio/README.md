# Nuvio PC Audio — Alpha 1 companion

**LG won't play DTS or TrueHD? PC to the rescue.**

This PC converts unsupported audio to Dolby Digital AC-3, up to 5.1 channels,
and sends it to your LG with the video copied unchanged. Supported audio plays
directly on the TV. Keep this PC awake while it handles a stream.

[Full installation guide](https://github.com/ozggit/nuvio-native-legacy/blob/pc-audio/docs/pc-audio/INSTALL.md)
· [Alpha downloads](https://github.com/ozggit/nuvio-native-legacy/releases/tag/pc-audio-2.0.85-alpha.1)

This companion is for the separate **Nuvio Legacy PC Audio** test app, based on
Nuvio Legacy 2.0.8. The test IPK uses ID `space.nuvio.native.legacy.pcaudio`, version
`2.0.85`, with a large **PC AUDIO** label and an amber computer/sound-wave
symbol beside the Nuvio play mark. It does not replace the original app.
Install this IPK manually in webOS Dev Manager over the earlier PC Audio test
app; the app ID stays the same. The original Nuvio Legacy stays separate.

## Windows setup

1. Keep this folder together and run `Start.cmd`. Node 22+ and FFmpeg/FFprobe must
   be on PATH. This ZIP does not include those dependencies or a standalone EXE;
   see the installation guide above for downloads. No `npm install` is needed.
2. Open `http://127.0.0.1:8788`, select the correct Wi-Fi/LAN address if needed,
   and choose **Show pairing code**.
3. In the test app: Settings → Playback → More options (or enable Advanced).
   Under this TV's sound/video options, choose **Pair PC audio server**. Enter
   the **four digits** shown on the PC and select **Done**. Stay in settings
   until pairing completes, then enable **PC audio fallback (experimental)**.
4. Browse your usual add-ons and select movie/episode sources normally.
   No add-on changes or media library are needed.
5. The PC must be awake for unsupported-audio playback. `Stop.cmd` exits the
   companion; the page's Stop button stops only its current session.

If Windows blocks the TV connection, run `Allow-TV.ps1` in an Administrator
PowerShell to allow Node TCP 8787 from the local subnet. Setup is loopback-only on 8788.
Only use this service on a trusted LAN; do not forward its ports to the Internet.
Pairing codes expire after two minutes, work once, and lock after five incorrect
attempts. The PC advertises discovery on UDP 8789 while a code is open; the TV
exchanges the code over existing TCP 8787. No IP address or long key is typed
on the TV. Keep both devices on the same local network; guest/client isolation
can block automatic discovery. The persistent authentication key stays internal.

## Behavior

The companion page follows Nuvio Legacy's dark theme, jade accent and bundled
Inter Display typeface. It explains the stream → PC → LG flow, shows the current
audio/output channels and copied video, and keeps four-digit pairing alongside
playback status. Network options are tucked into an expandable section. Bundled
fonts retain their license in `assets/FONT-LICENSE.txt`.

- Normal audio plays directly on the TV, without contacting this server.
- The enabled fallback starts after the TV identifies DTS/DTS-HD or TrueHD/MLP
  on a movie/episode. Trailers and live TV are not routed through it.
- If the LG reports no audio tracks for three seconds after loading the video,
  or rejects audio without identifying its codec, the PC inspects the original
  file. This covers LG pipelines that hide unsupported audio entirely. Inspection
  still converts only DTS/DTS-HD/TrueHD/MLP; known supported audio stays direct.
- PC fallback takes priority over the TV's local DTS converter for that playback.
  Turning PC fallback off restores the normal local conversion behavior. The
  app does not run both converters or silently switch to local stereo on failure.
- During PC preparation/loading the TV displays a persistent **PC audio fallback**
  banner and **Back - cancel and choose another stream**. Back stops the session
  and opens the source list. The banner clears when loading finishes and is
  independent of the cinema/compact/expanded loading preference.
- The PC selects English main audio, copies H.264/HEVC video, and converts
  unsupported audio to AC-3. 7.1 becomes 5.1; stereo and mono are not upmixed.
- If the selected English audio is already supported, the server reports direct
  playback. It does not transcode supported audio merely to label it 5.1.
- Continuous MPEG-TS is streamed through bounded pipes, with no whole-film cache.
  Seeking creates a replacement session at a video keyframe and reports its
  actual start. Full duration comes from the original file.
  Files that cannot provide a safe keyframe seek return an explicit error;
  unindexed MPEG-TS sources may have this limitation.
- Pausing relies on HTTP backpressure; long pauses and server disconnect behavior
  still need verification on the LG. Playback errors do not trigger local stereo
  conversion or automatic source switching while the PC session is active.
- The page shows one current session. Data requests are not proof the TV rendered
  video or that the soundbar received 5.1.

## Current limitations and validation

Local tests cover DTS core 5.1, DTS-HD MA 5.1, TrueHD 7.1 → AC-3 5.1, English selection, unchanged
decoded H.264/HEVC frames, keyframe seeks including nonzero MKV timestamps, headers, cancellation and access
control. The native worker's generation/stop/seek tests also ran on the TV CPU.
The user confirmed actual playback with 2.0.83: Nuvio reports AC-3 5.1 and Sonos
reports Dolby Digital 5.1. This confirms that tested stream, not every source.
Real high-bitrate remuxes, HDR/Dolby Vision, long pauses and resume still need
on-device verification. The 2.0.85 banner and Back flow need a manual TV check.

Embedded subtitles and changing the audio track are not implemented in the PC
transport. External subtitle timing after a PC seek is unverified. AC-3 does not
retain lossless audio, Atmos/DTS:X objects, or more than 5.1 channels. Video is never
re-encoded. Startup includes source resolution, probing and TV buffering.

The legacy add-on/HLS endpoints remain for regression tests only; the native
feature does not require them. Do not install that old wrapper as the new solution.

## Development and privacy

Run `node --test test/*.test.mjs`. Generated fixtures are temporary and cleaned up.
The optional DTS-HD MA run sets `NUVIO_DTSHD_FIXTURE` to FFmpeg FATE's
`dts/dcadec-suite/xll_51_24_48_768.dtshd` (SHA-256
`c0830af121ec78a8271d008999cc54b99843f17b9b33203bb9adbcbbc3271d0a9`).
This is a 64 ms decoder fixture looped into a test movie, not a complete real-world
remux. Obtain it from `https://fate-suite.ffmpeg.org/dts/dcadec-suite/`; it is not
redistributed in this companion.
The native control API is `/v1/sessions/<random client ID>` (PUT/GET/DELETE), using
a bearer token. Playback uses a separate per-session capability URL. Headers and
source URLs travel in JSON bodies, not query parameters. Browser-origin requests
to the native API are rejected; the setup page uses its own ephemeral token.

`data/` contains the pairing secret and private runtime state. Never share it.
TV pairing is local-only in `pcaudio-local.txt`, excluded from account sync and
packaging. Downloaded application integration settings used during builds come
only from checksum-pinned public releases; no personal account state is published.

Rollback: exit the PC Audio app and open the unchanged original Nuvio Legacy.
