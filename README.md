# DriveHop

DriveHop is a controller-first, dual-pane storage manager for jailbroken PS5
consoles. Internal storage starts on the left; a detected M.2 or USB drive starts
on the right. Pick either drive header to change that side, select a game, then
copy or move it in either direction.

This project is independent homebrew and is not affiliated with Sony.

## What is implemented

- Polished native 1080p/4K PS5 interface built with PS5 React.
- Custom 4K BC7 home-screen artwork shown while DriveHop is highlighted.
- Internal SSD, M.2 (`/mnt/ext0`, `/mnt/ext1`) and USB (`/mnt/usb0` through
  `/mnt/usb7`) discovery, selection and capacity reporting.
- Dual-pane libraries that scan each drive's `homebrew`, `etaHEN/games`, and
  (for removable drives) top-level directory.
- Vertical navigation stays inside its current pane; Left/Right explicitly
  switches panes.
- A guarded **Clear Cache** action invalidates DriveHop artwork/metadata,
  removes its disposable speed-test file, resets ShadowMountPlus scan attempts,
  and requests a full library rescan. It never deletes games, saves, `app.db`,
  or `/user/appmeta`.
- Extracted game folders plus `.ffpkg`, `.exfat`, `.ffpfs` and `.ffpfsc` images.
- Real game names and tile artwork from ShadowMountPlus's local game catalog;
  installed app metadata and filename-based labels remain as offline fallbacks.
- Copy or move in either direction.
- Resumable background transfers. Data is written under `<destination>.partial`,
  verified byte-for-byte, and atomically renamed into place.
- A move deletes the original only after verification and after confirming that
  the selected source is still the same filesystem object.
- Console sleep is held off during a transfer.
- Existing destinations are never overwritten.
- Persistent multi-game queue with combined destination-space preflight.
- Duplicate-title warnings when the same title exists on both selected drives.
- Recovery screen for resuming or removing abandoned `.partial` transfers.
- Per-drive verified write/read speed test.
- Best-effort ShadowMountPlus `manual.lst` source replacement after a move and
  local API refresh after successful transfers.

DriveHop intentionally does **not** list `.pkg` installers or ZIP/RAR/7z
archives. Those are transferable bytes, but they are not directly mountable game
images and presenting them as ready games would be misleading.

## Safety model

The copy implementation comes from PS5 React's native filesystem worker. It:

1. writes to a hidden `.partial` destination;
2. supports restart/resume at durable 32 MiB chunk boundaries;
3. rereads and verifies the destination against hashes captured from the source;
4. publishes the final path only after verification;
5. preserves the source if the operation fails or is cancelled.

For a move, DriveHop performs deletion as a separate final step. A cancelled or
failed job may leave a resumable `.partial` item, but never a partially published
game at the final destination.

## Build

PS5 React currently supports building on Apple-silicon macOS. Install its
prerequisites, then build DriveHop from a checkout next to this repository:

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
use the included GitHub Actions workflow: GitHub's `macos-15` runner is an M1
Mac and produces a checksummed `DriveHop-PPSA99777-v0.3.5` artifact. See
[`docs/BUILD-ON-GITHUB.md`](docs/BUILD-ON-GITHUB.md).

Run the platform-neutral model tests anywhere Node.js is available:

```sh
npm test
```

## Install on the PS5

1. Build or download the `PPSA99777` folder artifact.
2. Copy the folder to `/data/homebrew/PPSA99777`.
3. Run the filesystem-access prerequisite used by PS5 React (resident Lapy or a
   compatible ELF loader on port `9021`).
4. Run ShadowMountPlus and let it register the folder.
5. Close any running game, then open **DriveHop** from the Games row.

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
- `tests/` — host-side behavior tests.
- `docs/FORMAT-RESEARCH.md` — supported-format decision record.

## License

DriveHop is GPL-3.0-or-later. PS5 React and its bundled dependencies retain
their own licenses and notices.
