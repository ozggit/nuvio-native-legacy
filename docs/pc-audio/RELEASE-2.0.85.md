# PC Audio Alpha 1 — TV 2.0.85 / companion 0.2.1

7 November 2026. Independent, unofficial Nuvio Legacy PC Audio edition based on Nuvio Legacy 2.0.8.

## What is included

- Separate LG webOS app (`space.nuvio.native.legacy.pcaudio`) with a prominent PC AUDIO icon and computer/sound symbol.
- Windows companion that converts DTS/DTS-HD/TrueHD/MLP audio to Dolby Digital AC-3, up to 5.1, while copying H.264/HEVC video unchanged.
- Four-digit LAN pairing with expiring, single-use codes.
- Fallback when LG plays video but omits unsupported audio tracks entirely.
- TV loading banner identifying PC fallback; Back cancels the PC session and returns to the source list.
- Nuvio-style companion dashboard with source/output audio details and connection status.

Known supported audio plays directly on the TV. PC fallback takes priority over local DTS conversion when enabled. No upstream update is installed over this separate app.

## Install / update

Follow [INSTALL.md](INSTALL.md). Install the IPK manually through webOS Dev Manager. Existing PC Audio users can update in place; the original Legacy app remains separate. A working companion 0.2.0 is compatible with this TV update; companion 0.2.1 adds the new icon. The ZIP needs Node 22+ and FFmpeg/FFprobe; it is not a standalone Windows installer.

## Validation

- The native detection, session/cancellation, stale-response and pairing tests passed in CI. The full ARM package build passed and the artifact/IPK hashes and icon contents were verified.
- Companion tests cover real DTS/TrueHD conversion, DTS-HD MA using an optional short decoder fixture, unchanged decoded H.264/HEVC frames, seeking, source headers, authentication and cancellation.
- A user confirmed real playback with 2.0.83: Nuvio showed AC-3 5.1 and Sonos reported Dolby Digital 5.1.
- The new 2.0.85 banner/Back flow has compiled and cancellation tests passed, but its visual/remote behavior still needs on-TV feedback. No TV installation is performed by the build workflow.

## Alpha limitations

English main audio is preferred. Embedded subtitles and audio-track switching are unavailable in PC mode. AC-3 is lossy and does not retain Atmos/DTS:X objects. Startup includes probing and TV buffering. Seeking follows video keyframes; some sources cannot safely seek. Broader LG compatibility, high-bitrate remuxes, HDR/Dolby Vision, long pauses and subtitle timing after seeking remain under test.

Please report issues [in this fork](https://github.com/ozggit/nuvio-native-legacy/issues/new/choose), without private stream URLs, account tokens or the companion's data folder.

## Source and provenance

TV binary: commit `a9cbc63081cb8ddf0ddf92dd657575fe94a559d4`, [build 42400917431](https://github.com/ozggit/nuvio-native-legacy/actions/runs/42400917431). The release tag adds public documentation and repository configuration without changing that native code or the TV assets. Matching source, component versions and hashes are attached to the release. [Build guide](BUILD.md) · [Credits and GPLv3](CREDITS.md).
