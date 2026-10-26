# Build DriveHop from Windows with GitHub Actions

DriveHop's native PS5 toolchain currently requires Apple-silicon macOS. A
physical Mac is not required: GitHub's standard `macos-15` Actions runner is an
M1/ARM64 virtual machine and is available to private as well as public
repositories.

## One-time setup

1. Create an empty GitHub repository. Private is fine.
2. Upload or push the complete DriveHop source tree, including the hidden
   `.github/workflows/build.yml` file.
3. Open the repository's **Actions** tab and allow workflows if GitHub asks.
4. Select **Build DriveHop**, choose **Run workflow**, and run it from `main`.

The workflow confirms `uname -m` is `arm64`, installs the pinned build
dependencies, builds with the current PS5 React project, and creates a checksummed
artifact named `DriveHop-PPSA99777-v0.2.0`.

## Download and install

1. Open the completed workflow run.
2. Download `DriveHop-PPSA99777-v0.2.0` from **Artifacts**.
3. Extract the artifact, then extract `DriveHop-PPSA99777-v0.2.0.zip`.
4. Copy the complete `PPSA99777` folder to `/data/homebrew/PPSA99777` on the PS5.
5. Start the filesystem-access prerequisite used by PS5 React, then run
   ShadowMountPlus so it registers the title.

Do not upload only `eboot.bin`: the `sce_sys`, `sce_module`, notices and helper
files next to it are part of the application.

## Cost and privacy

Public repositories receive unlimited standard-runner Actions usage. Private
repositories use the account's included Actions allowance and then the normal
macOS runner rate. A single build normally fits within the included allowance,
but the account's billing settings remain authoritative. The workflow uploads
the build artifact for 14 days and does not publish a GitHub Release.
