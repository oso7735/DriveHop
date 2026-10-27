# Third-party notices

## PS5Upload SMB helper and libsmb2

DriveHop's optional SMB helper is built from
[phantomptr/ps5upload](https://github.com/phantomptr/ps5upload) commit
`0cf022b71f466efdec133f56a9e4c3d74f0e94eb`, with a small DriveHop patch that
uses private paths/port and rejects NAS write and delete operations. PS5Upload is
GPL-3.0-or-later. Its bundled libsmb2 client is LGPL-2.1-or-later and includes
upstream security fixes documented in that source tree. Release artifacts include
the complete helper and libsmb2 source used for the binary.

DriveHop is designed to be built with PS5 React:

- PS5 React, created by half144 and PS5 React contributors and continued by
  JVK3R: https://github.com/JVK3R/ps5-react
- License: GPL-3.0-or-later with the framework's attribution-preservation term.

The PS5 React build system emits its complete dependency notices into built
artifacts. Those generated notices must remain with any redistributed binary.

The bundled Inter font files are Copyright 2020 The Inter Project Authors and
are licensed under the SIL Open Font License 1.1. The license text is included
at `app/drivehop/assets/Inter-LICENSE.txt`.

DriveHop interoperates with, but does not include, ShadowMountPlus:
https://github.com/drakmor/ShadowMountPlus
