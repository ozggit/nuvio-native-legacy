# Nuvio PC Audio — experimental native fallback

This companion is for the separate **Nuvio Legacy PC Audio** test app, based on
Nuvio Legacy 2.0.8. The test IPK uses ID `space.nuvio.native.legacy.pcaudio`, version
`2.0.81`, and a green/cyan PC-badged icon. It does not replace the original app.

## Windows setup

1. Keep this folder together and run `Start.cmd`. Node 22+ and FFmpeg/FFprobe must
   be on PATH (already installed on the development PC).
2. Open the pairing section on the local page at `http://127.0.0.1:8788`.
3. In the test app: Playback → PC audio fallback → Pair PC audio server. Paste
   the private pairing link, then enable PC audio fallback.
4. Browse Kaptain/Bingecat and select ordinary AIOStreams/TorBox sources normally.
   No add-on changes or media library are needed.
5. The PC must be awake for unsupported-audio playback. `Stop.cmd` exits the
   companion; the page's Stop button stops only its current session.

The existing LocalSubnet firewall rule for Node TCP 8787 can be reused. If this
is a different PC, `Allow-TV.ps1` adds that rule. Setup is loopback-only on 8788.
Only use this service on a trusted LAN; do not forward its ports to the Internet.

## Behavior

- Normal audio plays directly on the TV, without contacting this server.
- The enabled fallback starts after the TV identifies DTS/DTS-HD or TrueHD/MLP
  on a movie/episode. Trailers and live TV are not routed through it.
- The PC selects English main audio, copies H.264/HEVC video, and converts
  unsupported audio to AC-3. 7.1 becomes 5.1; stereo and mono are not upmixed.
- If the selected English audio is already supported, the server reports direct
  playback. It does not transcode supported audio merely to label it 5.1.
- Continuous MPEG-TS is streamed through bounded pipes, with no whole-film cache.
  Seeking creates a replacement session at a video keyframe and reports its
  actual start. Full duration comes from the original file.
- Pausing relies on HTTP backpressure; long pauses and server disconnect behavior
  still need verification on the LG. Playback errors do not trigger local stereo
  conversion or automatic source switching while the PC session is active.
- The page shows one current session. Data requests are not proof the TV rendered
  video or that the soundbar received 5.1.

## Current limitations and validation

Local tests cover DTS core 5.1, DTS-HD MA 5.1, TrueHD 7.1 → AC-3 5.1, English selection, unchanged
decoded H.264/HEVC frames, keyframe seek offsets, headers, cancellation and access
control. The native worker's generation/stop/seek tests also ran on the TV CPU.
Those are not a confirmed media playback test. Real high-bitrate remuxes, HDR/Dolby Vision,
long pauses, resume and actual TV/soundbar output need on-device verification.

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
