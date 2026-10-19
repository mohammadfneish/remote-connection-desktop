<p align="center"><img src="build/icon.png" alt="Remote Connection" width="120" /></p>

# Remote Connection — Desktop

The desktop client for **Remote Connection**, a free, secure remote-desktop app: see and control
another computer over the internet, peer-to-peer and end-to-end encrypted.

This repository is the open-source desktop client (Electron). The signaling/relay server is
operated separately.

## Features

- Peer-to-peer screen sharing with full mouse & keyboard control
- Clipboard sync and two-way file transfer
- Multiple monitors, view-only mode, live connection stats
- Unattended access with a permanent password, optional two-factor (TOTP), and trusted devices
- Automatic update checks
- Every connection is shown to the host (banner + notification) and can be disconnected anytime

## Develop

Requires Node.js 22+.

```bash
npm install
npm start
```

Run a second instance (its own device ID) to test locally:

```bash
npm run start:b
```

Point it at a server with `--server`, e.g. `npm start -- --server=ws://localhost:7070`.
By default it connects to the server in `remoteConnection.defaultServerUrl` in `package.json`.

## Build installers

```bash
npm run dist          # Windows (NSIS .exe)
npm run dist -- --mac # macOS (.dmg) — on macOS
npm run dist -- --linux
```

Output goes to `dist/`.

## Tests

```bash
npm test
```

## License

[MIT](LICENSE). © 2026 NovaTech.

## Code signing

The Windows installer is signed through [SignPath.io](https://signpath.io), with a certificate from
the [SignPath Foundation](https://signpath.org).
