# Build DriveHop from Windows with GitHub Actions

PS5 React documents Apple-silicon macOS for its full development environment.
DriveHop only needs the PS5 cross-build, so its workflow uses GitHub's standard
`macos-15-intel` runner and does not build or run the macOS desktop preview.

## One-time setup

1. Create an empty GitHub repository. Private is fine.
2. Upload or push the complete DriveHop source tree, including the hidden
   `.github/workflows/build.yml` file.
3. Open the repository's **Actions** tab and allow workflows if GitHub asks.
4. Select **Build DriveHop**, choose **Run workflow**, and run it from `main`.

The workflow confirms the Intel macOS host, installs the pinned build
dependencies, builds with the current PS5 React project, and creates a checksummed
artifact named `DriveHop-PPSA99777-v0.7.0`.

## Download and install

1. Open the completed workflow run.
2. Download `DriveHop-PPSA99777-v0.7.0` from **Artifacts** and extract it.
3. Close DriveHop if it is running. Send `DriveHop-Installer-v0.7.0.elf` to the
   PS5's ELF loader on port `9021` with Payload Manager or another sender.
4. Wait for the completion notification. The installer embeds the full app,
   verifies it on the console, applies `0777` recursively and requests a
   ShadowMountPlus rescan.

The ZIP and permissions-preserving `.tar.gz` in the artifact remain available
for manual or recovery installation.

Do not upload only `eboot.bin`: the `sce_sys`, `sce_module`, notices and helper
files next to it are part of the application.

## Cost and privacy

Public repositories receive unlimited standard-runner Actions usage. Private
repositories use the account's included Actions allowance and then the normal
macOS runner rate. A single build normally fits within the included allowance,
but the account's billing settings remain authoritative. The workflow uploads
the build artifact for 14 days and does not publish a GitHub Release.
