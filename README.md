# DriveHop

DriveHop is a controller-first, dual-pane storage manager for jailbroken PS5
consoles. Internal storage starts on the left; a detected M.2 or USB drive starts
on the right. Pick either drive header to change that side, select a game, then
copy or move it in either direction.

This project is independent homebrew and is not affiliated with Sony.

## Support DriveHop

If DriveHop has been useful to you, you can support its continued development
through [PayPal](https://paypal.me/ChristianOsorio674).

## What is implemented

- Polished native 1080p/4K PS5 interface built with PS5 React.
- Automatic console-language detection through the PS5 system setting. English
  and Spanish (`es`, including Latin American Spanish) are included; unsupported
  languages fall back to English without changing game titles or paths.
- A controller-first Settings screen with persistent Midnight, Ocean, Ember and
  Amethyst themes.
- Optional **Delete source after Copy** behavior. It is off by default and turns
  a successful Copy into a source-removing operation only after the selected
  verification, publication and source-identity checks have completed. SMB
  transfers never delete their source.
- Custom 4K BC7 home-screen artwork shown while DriveHop is highlighted.
- Internal SSD, M.2 (`/mnt/ext0`, `/mnt/ext1`) and USB (`/mnt/usb0` through
  `/mnt/usb7`) discovery, selection and capacity reporting.
- SMB2/SMB3 NAS read/write Copy support through a bundled, pinned `libsmb2` helper.
  A PIN-protected phone/computer page collects the server, share and credentials;
  the NAS then appears as a selectable drive in either pane. A persistent
  **Allow writing to NAS** setting controls uploads. Multi-select,
  destination-space checks, progress and cancellation work in both directions.
- Atomic, resumable NAS uploads. DriveHop copies into a hidden, source-identity
  keyed `<game>.drivehop-<token>.drivehop-stage` path, resumes completed folder files and partial-file
  bytes after interruption, then publishes the complete game with a same-folder
  SMB rename. The final game name is never used for an incomplete upload.
- Dual-pane libraries that scan each drive's `homebrew`, `etaHEN/games`, and
  (for removable drives) top-level directory.
- Vertical navigation stays inside its current pane; Left/Right explicitly
  switches panes.
- Cross toggles selection in either pane. Copy and Move preflight the whole
  active-pane selection, then run each transfer sequentially or add the complete
  batch to the persistent queue.
- **Verified** mode rereads every destination byte before publication. Optional
  **Turbo** mode removes that second whole-game I/O pass while retaining a fresh
  staged copy, `fsync`, size validation, atomic publication and source-identity
  checks. Verified remains the default and Turbo mode is saved per user.
- A guarded **Clear Cache** action invalidates DriveHop artwork/metadata,
  removes its disposable speed-test file, resets ShadowMountPlus scan attempts,
  and requests a full library rescan. It never deletes games, saves, `app.db`,
  or `/user/appmeta`.
- An **Updates** screen checks the official `oso7735/DriveHop` GitHub releases.
  New installers are size-checked and SHA-256 verified before DriveHop sends
  them to the console's local ELF loader; failed installs keep the prior app.
- Extracted game folders plus `.ffpkg`, `.exfat`, `.ffpfs` and `.ffpfsc` images.
- Real game names and tile artwork from ShadowMountPlus's local game catalog;
  installed app metadata and filename-based labels remain as offline fallbacks.
- Copy or move in either direction.
- A preflight review runs before every confirmation. It checks destination
  conflicts, SMB-safe names, current free space, batch size and existing local
  or NAS staging data, and blocks Start until hard problems are resolved.
- Resumable Verified transfers. Data is written under `<destination>.partial`,
  verified byte-for-byte, and atomically renamed into place. Turbo retries start
  fresh rather than trusting bytes from an interrupted run.
- A move deletes the original only after the selected mode's checks and after
  confirming that the source is still the same filesystem object.
- Console sleep is held off during a transfer.
- Existing destinations are never overwritten.
- Persistent multi-game queue with combined destination-space preflight.
- Persistent transfer history for completed, cancelled, failed and interrupted
  NAS work. Failed entries can be retried, while a redacted JSON diagnostics
  report can be exported under `/data/drivehop/exports` for troubleshooting.
- Duplicate-title warnings when the same title exists on both selected drives.
- Recovery screen for resuming or removing abandoned `.partial` transfers.
- Per-drive verified write/read speed test.
- Best-effort ShadowMountPlus `manual.lst` source replacement after a move and
  local API refresh after successful transfers.

DriveHop intentionally does **not** list `.pkg` installers or ZIP/RAR/7z
archives. Those are transferable bytes, but they are not directly mountable game
images and presenting them as ready games would be misleading.

## Safety model

In the default Verified mode, PS5 React's native filesystem worker:

1. writes to a hidden `.partial` destination;
2. supports restart/resume at durable 32 MiB chunk boundaries;
3. rereads and verifies the destination against hashes captured from the source;
4. publishes the final path only after verification;
5. preserves the source if the operation fails or is cancelled.

For a move, DriveHop performs deletion as a separate final step. A cancelled or
failed job may leave a resumable `.partial` item, but never a partially published
game at the final destination.

NAS shares have a stricter policy: DriveHop permits Copy in either direction but
never overwrites or deletes an existing NAS item, and never offers Move for an
SMB transfer. Uploads live under a hidden `.drivehop-stage` top-level name;
individual files use `.ps5u-part` while incomplete. Cancellation keeps that
private staging data for a later retry, and successful completion atomically
renames the staging item to the requested final name.
The helper negotiates SMB2/SMB3 with signing enabled and validates transfer
sizes. Local
drive-to-drive transfers retain the stronger byte-for-byte verification
described above unless the user explicitly selects Turbo. Turbo never publishes
a partial destination and always syncs and size-checks it, but it does not reread
every byte; use Verified for irreplaceable sources and before deleting the only
trusted copy.

## Build

PS5 React documents Apple-silicon macOS as its supported development host.
DriveHop's CI uses Intel macOS for the PS5-only cross-build (no desktop preview),
which avoids depending on the scarce hosted M1 pool. For a local supported build,
install the prerequisites and build from a checkout next to this repository:

```sh
git clone https://github.com/JVK3R/ps5-react.git
cd ps5-react
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci
brew install cmake sdl2 llvm@18 curl libarchive openssl@3
PATH="$PWD/.venv/bin:$PATH" npm run build -- --app-dir ../DriveHop/app/drivehop
```

The result is written under PS5 React's `dist/PPSA99777` directory. From Windows,
use the included GitHub Actions workflow: GitHub's `macos-15-intel` runner
produces a checksummed `DriveHop-PPSA99777-v0.8.0` artifact. See
[`docs/BUILD-ON-GITHUB.md`](docs/BUILD-ON-GITHUB.md).

Run the platform-neutral model tests anywhere Node.js is available:

```sh
npm test
```

## Install on the PS5

1. Download `DriveHop-Installer-v0.8.0.elf` from the build artifact.
2. Close DriveHop if it is already running, then send the installer to the PS5's
   ELF loader on port `9021` using Payload Manager or another payload sender.
3. Wait for the installation notification. The installer stages and verifies
   every embedded file, atomically installs `/data/homebrew/PPSA99777`, applies
   mode `0777` recursively, and asks ShadowMountPlus to rescan.
4. Open **DriveHop** from the Games row. If the notification says
   ShadowMountPlus was unavailable, start it first.

The installer is offline: it does not download code or require GitHub access
from the console. Failed updates retain the previous installation. Its log is
written to `/data/drivehop/installer.log`.

After this first installation, DriveHop checks for a newer official release at
startup. Open **Updates** to check manually, download a verified installer, and
select **Install and close DriveHop**. The final step requires an ELF loader on
port `9021`, just like a manual installer launch.

For recovery or manual installation, extract `DriveHop-PPSA99777-v0.8.0.zip`
and copy its complete `PPSA99777` folder to `/data/homebrew/PPSA99777`.

Release archives explicitly store mode `0777` on every directory and file. The
workflow rejects an archive containing any other mode. The artifact also includes
a `.tar.gz` variant for extractors that preserve POSIX modes more reliably than
Windows ZIP tools.

DriveHop requires broad filesystem access because its purpose is moving data
between console-wide storage roots. Install only a build whose source and hash
you trust.

The **Clear Cache** button is intentionally limited to DriveHop and
ShadowMountPlus. The PS5 system-software cache is a separate maintenance action
that Sony exposes only from Safe Mode; DriveHop does not imitate it by deleting
undocumented system files.

## Compatibility and limitations

- DriveHop v0.2.0 was hardware-tested successfully on a PS5. New releases retain
  host-side coverage, but storage operations should still be tested with Copy
  before Move after an update.
- Artwork and container metadata require ShadowMountPlus's local API on
  `127.0.0.1:10101`. When it is unavailable, DriveHop remains usable and falls
  back to `/user/appmeta` metadata and cleaned filenames.
- Folder sizes are intentionally not calculated during library browsing because
  recursively walking tens of thousands of files would stall the UI. The native
  copy worker reports the full size after a transfer starts.
- `.ffpfs` and `.ffpfsc` support follows ShadowMountPlus, where PFS remains
  experimental. DriveHop transfers these files without converting them.
- SMB requires an IPv4-reachable NAS with SMB2 or SMB3 enabled. SMB1 is not
  supported. Use a dedicated NAS account restricted to the selected game share;
  give it write access only if uploads are wanted. A password is
  session-only unless Remember password is selected; remembered settings are
  stored mode `0600` under `/data/drivehop/smb`.
- A copied duplicate is not forced into ShadowMountPlus's manual list. A move
  replaces the old source hint with the new path; normal scan paths still apply.
- The app uses homebrew title ID `PPSA99777`. It was not found in the public
  indexes checked during development, but there is no central authoritative
  registry for unofficial title IDs.

## Recommended first-console test

Start with a small title and **Copy**, not Move. Confirm it appears in the other
pane and mounts normally before testing Move. Run the speed test on each drive,
then use the faster writable destination. If power is interrupted, open Recovery
and resume the matching `.partial` transfer; do not rename partial files by hand.

The next useful additions are optional recursive folder-size calculation and a
diagnostic log export that can be attached to bug reports.

## Project layout

- `app/drivehop/index.jsx` — native dual-pane UI and transfer workflow.
- `app/drivehop/library.js` — drive, path, format and safety helpers.
- `app/drivehop/smb.js` and `smb_bridge.c` — SMB validation, catalogue model and
  loopback bridge to the bundled helper.
- `tests/` — host-side behavior tests.
- `docs/FORMAT-RESEARCH.md` — supported-format decision record.

## License

DriveHop is GPL-3.0-or-later. PS5 React and its bundled dependencies retain
their own licenses and notices.
