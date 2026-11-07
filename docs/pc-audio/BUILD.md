# Source and build guide

## Release provenance

The first PC Audio alpha pairs TV app **2.0.85** with Windows companion **0.2.1**.
The TV IPK was built from commit `a9cbc63081cb8ddf0ddf92dd657575fe94a559d4`
by [workflow run 42400917431](https://github.com/ozggit/nuvio-native-legacy/actions/runs/42400917431).
The release tag adds distribution documentation, issue templates and branch configuration; it does not change the native playback source or TV assets from that build.

The release includes a source archive for the tagged tree, a provenance manifest and `SHA256SUMS.txt`. The companion ships as source with its UI/assets; Node and FFmpeg are installed separately by the user. The original upstream tree and commit history remain in this repository.

## Rebuild the TV IPK

The canonical build recipe is [`.github/workflows/pc-audio-test.yml`](../../.github/workflows/pc-audio-test.yml). Run **PC Audio test IPK → Run workflow** on the `pc-audio` branch, or reproduce its commands on Linux x86-64 with Docker, Python 3, Git, Node/npm and Rust available. GitHub Actions builds packages only; it never installs or contacts a TV.

The workflow:

1. Runs native detection, session/cancellation and pairing tests.
2. Installs `@webos-tools/cli@3.2.1` and Rust 1.88.0 with the `armv7-unknown-linux-gnueabi` target; fetches Cargo dependencies with the checked-in lockfiles.
3. Runs `python3 tools/pc-audio-public-config.py` to recover application integration settings from checksum-pinned **public** upstream packages. The values are verified against the upstream 2.0.8 binary. It does not read user accounts or installed TV data. The generated `local.properties` is ignored and excluded from distribution.
4. Builds `tools/Dockerfile` with the x86-64 webOS SDK URL specified in the workflow, including libass, local DTS support and the DV7 toolchain.
5. Makes the SDK cross compiler available to host Rust builds, then builds the pinned Nuvio P2P engine and patch using `tools/p2p-motor/build-arm.sh`.
6. Runs `bash tools/build-pc-audio.sh --output build/pc-audio` with the workflow's environment variables. The script stages a separate tree, sets the PC Audio identity, retains original native dependencies and excludes runtime/user data.
7. Audits app identity and required payload, then produces the IPK, metadata JSON and SHA-256 file.

Use the workflow's exact SDK URL, environment and steps rather than the unrelated inherited Android/Tizen build workflows. Native compilation is performed for ARMv7; the SDK container runs on linux/amd64 in CI. A rebuild is not claimed to be byte-for-byte reproducible across dates/toolchains.

## Run the focused tests

On a POSIX host with a C compiler:

```sh
cc -Isrc -Wall -Wextra -Werror tests/pcaudio_detect.c -o /tmp/pcaudio-detect-test
/tmp/pcaudio-detect-test
cc -DNV_WEBOS -Isrc -Wall -Wextra -Werror tests/pcaudio.c src/pcaudio.c src/js.c -lpthread -lm -o /tmp/pcaudio-test
/tmp/pcaudio-test
cc -DNV_WEBOS -Isrc -Wall -Wextra -Werror tests/pcpair.c src/pcpair.c src/js.c -lpthread -lm -o /tmp/pcpair-test
/tmp/pcpair-test
```

With Node 22+, FFmpeg and FFprobe on PATH:

```sh
cd companion/pc-audio
node --test test/*.test.mjs
```

The optional DTS-HD fixture and its checksum are documented in the [companion README](../../companion/pc-audio/README.md). It is not included in release archives. Synthetic media tests do not replace device checks.

## Dependency source and notices

The source tree includes the application, companion, local patches, build scripts and Cargo lockfiles. External source locations/version selection used by those scripts are below; preserve those sources and notices when redistributing builds.

| Component | Source/version and build recipe |
|---|---|
| Nuvio Engine | [`02938d7`](https://github.com/NuvioMedia/nuvio-engine/tree/02938d7), plus [`janela-334.patch`](../../tools/p2p-motor/janela-334.patch); pinned in [`pasta.sh`](../../tools/p2p-motor/pasta.sh) |
| libtorrent | [2.0.12, commit `740a0b9aeabe00e762cc0efe4a0f27593db2550b`](https://github.com/arvidn/libtorrent/tree/740a0b9aeabe00e762cc0efe4a0f27593db2550b); engine CMake dependency |
| Embedded FFmpeg | [7.1.5 source](https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz), checksum and configuration in [`build-dts-ffmpeg.sh`](../../tools/build-dts-ffmpeg.sh); packaged `licenses/dts/SOURCE.txt` |
| libass / text libraries | libass 0.17.5, FreeType 2.13.3, FriBidi 1.0.16, HarfBuzz 10.4.0; source URLs and build options in [`build-ass-arm.sh`](../../tools/build-ass-arm.sh) |
| Rust MKV / DV7 components | [`rust/mkvcore`](../../rust/mkvcore) and [`tools/dv7`](../../tools/dv7), with Cargo.lock and license/source material; generated DV7 notices accompany the IPK |
| webOS cross SDK / system libraries | [openlgtv buildroot-nc4](https://github.com/openlgtv/buildroot-nc4), SDK tag `webos-a38c582`; exact SDK asset selected in the workflow |
| Other bundled assets/libraries | Notices under [`deploy/app/licencas`](../../deploy/app/licencas), [`deploy/app/fonts`](../../deploy/app/fonts), vendor directories and generated IPK `licenses` folders |

The full app remains under [GPLv3](../../LICENSE). Third-party components retain their own license terms. See [credits](CREDITS.md). Do not replace source links with a link only to a binary release.

## Maintaining this fork

`pc-audio` is the public development/default branch. Keep upstream changes reviewed and merge them here when appropriate; no upstream pull request is required to maintain this edition. Keep the separate app ID and manual update policy until a fork-specific update channel is deliberately implemented.

For each release, tag the reviewed tree, publish matching source/build information, update the component/version table, and create a GitHub prerelease labelled **Alpha**. Prepare all assets in a draft, verify them, then publish. Never include `data/`, personal configuration, private source URLs, tokens or TV developer credentials. Public GitHub Releases are the distribution channel; temporary workflow artifacts are not the long-term download links.
