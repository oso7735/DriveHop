# Format and storage research

Research date: 2026-10-25.

## Allowed game sources

| Source | DriveHop | Reason |
| --- | --- | --- |
| Extracted game folder | Allowed | ShadowMountPlus recognizes a game root containing `sce_sys/param.json`; DriveHop additionally requires `eboot.bin` to avoid listing ordinary homebrew data folders. |
| `.ffpkg` | Allowed | ShadowMountPlus's recommended UFS image format for normal use. |
| `.exfat` | Allowed | Supported compatibility format, commonly used for external-drive-style titles. |
| `.ffpfs` | Allowed, marked experimental upstream | Uncompressed PFS image supported by ShadowMountPlus. |
| `.ffpfsc` | Allowed, marked experimental upstream | Compressed PFS container supported by ShadowMountPlus. |

## Excluded sources

| Source | Why it is excluded from the game panes |
| --- | --- |
| `.pkg` | An installer package, not a ShadowMountPlus game image. It needs a compatible package installer. |
| `.zip`, `.rar`, `.7z` | Archives must be extracted before their contained format is known or playable. |
| `.partial`, `.part`, hidden files | Incomplete or implementation-owned data must never be presented as a game. |

## Storage roots

- Internal SSD: `/data/homebrew` and `/data/etaHEN/games`
- M.2/extended: `/mnt/ext0`, `/mnt/ext1`, including their `homebrew` and
  `etaHEN/games` folders
- USB: `/mnt/usb0` through `/mnt/usb7`, including their `homebrew` and
  `etaHEN/games` folders

Transfers always target the conventional `<drive>/homebrew` directory. Source
discovery is broader so existing installations at supported legacy paths remain
visible.

## Primary references

- ShadowMountPlus repository and current image support:
  https://github.com/drakmor/ShadowMountPlus
- ShadowMountPlus releases and compatibility notes:
  https://github.com/drakmor/ShadowMountPlus/releases
- PS5 React filesystem API and verified-copy behavior:
  https://github.com/JVK3R/ps5-react
- Orbit Store's user-facing distinction between mountable images, packages and
  archives:
  https://github.com/saawant12/orbit-store-ps5/blob/main/README.md

No game content, proprietary SDK component, or Sony library is included.
