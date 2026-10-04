<div align="center">

# Phomymo Next

**A label designer for Phomemo thermal printers — in your browser, in Arabic and English.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Lojs/phomymo-next?label=Release&color=blue)](https://github.com/Lojs/phomymo-next/releases/latest)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ed?logo=docker&logoColor=white)](https://github.com/Lojs/phomymo-next/pkgs/container/phomymo-next)

Text, images, barcodes, QR codes, shapes, multi-label rolls, and CSV batch
printing — designed on screen and printed straight from the browser over
Bluetooth or USB.

</div>

---

## Screenshots

<div align="center">

<img src="docs/screenshots/desktop-en.png" alt="Phomymo Next editing a 60×40 mm product label" width="100%">

<sub>Designing a 60×40 mm coffee label — text, rules, a CODE128 barcode and a QR code</sub>

<br><br>

<img src="docs/screenshots/desktop-ar.png" alt="The same app in Arabic, mirrored to RTL" width="100%">

<sub>The same design in Arabic — the entire interface mirrors to right-to-left</sub>

<br><br>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/mobile.png" alt="Phone layout" width="260"></td>
</tr>
<tr>
<td align="center"><sub>On a phone the inspector becomes a bottom sheet</sub></td>
</tr>
</table>

</div>

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Accessing it from another device](#accessing-it-from-another-device)
- [Commands](#commands)
- [Where your data lives](#where-your-data-lives)
- [Local development](#local-development)
- [Architecture](#architecture)
- [Credits and provenance](#credits-and-provenance)
- [Licence](#licence)

---

## Features

| | |
|---|---|
| **Real label sizes** | 12 preset sizes, round labels, continuous tape, or any custom size in millimetres. The size you pick *is* the paper in the printer — orientation never rewrites it. |
| **Portrait and Landscape** | On any rectangular label. Switching rotates your whole design 90° as one piece; nothing is reset. |
| **Bluetooth and USB** | Print width, DPI and alignment are taken from the detected printer model — 18 built-in definitions, plus your own. |
| **Batch printing** | One design, many records, from a CSV or the in-app table. Fields (`{{SKU}}`) and expressions (`[[date]]`). |
| **Print preview** | Images shown as they will actually dither on paper, while text and barcodes stay crisp. |
| **Import / export** | Designs as JSON, PNG or PDF; data as CSV. |
| **Arabic and English** | A full right-to-left layout, not a translation layer. |

---

## Requirements

Bluetooth and USB printing use the **Web Bluetooth** and **WebUSB** APIs, which work
**only in Chrome or Edge**, and **only in a secure context** — HTTPS, or
`http://localhost`. That is why the container serves the app over HTTPS.

> **A self-signed certificate is enough to print, but not to install.**
> The browser will warn once; click through it and the origin counts as secure, so
> Bluetooth and USB work. Installing as a PWA (Chrome refuses a service worker on an
> origin whose certificate was accepted by clicking through) needs a certificate a
> browser already trusts — see *Using your own certificate instead*, below.

---

## Quick start

```sh
cp .env.example .env        # edit PHOMYMO_DOMAIN if you need LAN access
docker compose up -d --build
```

Open **https://localhost:8444**.

The stack publishes a **single port** (`8444:443`). There is no plain-HTTP port
to redirect from, so always use `https://` and the port explicitly.

---

## Accessing it from another device

Compose publishes the port on all interfaces, so anything on your network can
reach it. You only need to tell the container which address to put in its
certificate.

1. Find this machine's LAN IP — `hostname -I` on Linux, or check your router.
2. Put it in `.env` (optional; without it the app assumes `localhost`):
   ```sh
   PHOMYMO_DOMAIN=192.168.1.50
   ```
3. Restart so the certificate is regenerated for that address:
   ```sh
   docker compose up -d
   ```
4. Open **https://192.168.1.50:8444**.

<details>
<summary>Using your own certificate instead</summary>

Copy `cert.pem` and `key.pem` into `./phomymo-certs/` on the host, then restart:

```sh
cp ./cert.pem ./phomymo-certs/cert.pem
cp ./key.pem  ./phomymo-certs/key.pem
docker compose restart
```

`./phomymo-certs` is a **bind mount**, not a named volume, so the files stay
plain files you can read, replace or back up — and `docker compose down -v`
leaves them alone.

The container will not touch a certificate you supplied. A marker file,
`phomymo-certs/.self-signed-for`, records the address and fingerprint of the
*self-signed* certificate it generated; if that marker is missing or its
fingerprint no longer matches the certificate on disk, the certificate is
yours and it is left alone. Change `PHOMYMO_DOMAIN` and the self-signed one is
regenerated on the next start rather than left reporting a name mismatch.

</details>

---

## Commands

| Action | Command |
|---|---|
| Build the image | `docker compose build` |
| Start (builds if needed) | `docker compose up -d --build` |
| Start without rebuilding | `docker compose up -d` |
| Stop | `docker compose down` |
| View logs | `docker compose logs -f` |
| Check it's running | `docker compose ps` |
| Full reset | `docker compose down` |
| Reset including the certificate | `rm -rf phomymo-certs && docker compose up -d` |

---

## Where your data lives

The **only** thing persisted on the server is the HTTPS certificate, in
`./phomymo-certs` on the host (mounted at `/certs`). It survives restarts and
rebuilds — otherwise you would see a fresh browser warning every time — and the
entrypoint warns at startup if it is within 30 days of expiry. Because it is a
bind mount, `docker compose down -v` does **not** remove it.

Everything else — designs, settings, printer memory, template data — lives in
the browser's `localStorage` on each device that opens the app. The server is
stateless otherwise, so `docker compose down` never touches it.

> **This is per-device and per-browser.** Clearing site data, switching browser,
> or opening the app in a private window all start from empty. Export anything
> you want to keep (`Export JSON` / `Export CSV` in the designs dialog).

---

## Local development

```sh
npm install
npm run dev         # http://localhost:5173 — localhost counts as secure, so BLE/USB work here too
npm run build       # production build into dist/
npm test            # unit + golden tests
npm run test:ci     # the same, plus coverage thresholds — what CI runs
npm run typecheck
```

### Tests

**1218 tests** across 48 files — 1200 run here, and 18 more are the nginx
routing tests, which skip themselves when nginx is not installed and run on CI.
Many are **golden tests**: they compare this rewrite's output byte-for-byte
against a frozen copy of the original implementation in `tests/legacy/`, so a
refactor cannot quietly change what reaches the paper.

The count moves as the suite grows, and `npx vitest list` under-reports it (it
skips the jsdom project). Read it off the last line of `npm test` instead:
`Tests  1200 passed | 18 skipped (1218)`.

`npm run typecheck` and `npm run build` are separate; CI runs all three before
anything is published. Note that `npm test` alone does **not** compute coverage —
use `npm run test:ci` to exercise the thresholds in `vite.config.ts` (80%
statements, 70% branches), which is what CI enforces.

Three places deliberately diverge from the legacy behaviour, each asserted
explicitly so it cannot drift silently:

- an empty CSV file is reported as empty, not parsed as one nameless column;
- a malformed CSV row is reported by its real line number;
- **a label wider than the printer is clipped to the printer's print width.**
  The legacy `packBits()` computed a negative offset in that case and then wrote
  past the end of each row, overwriting the next — a 60 mm label on a 40 mm
  printer produced a blank label with no error. See
  `tests/raster-overflow.test.ts`.

See `tests/golden-raster-templates.test.ts` for what each one changed and why.

---

## Architecture

| Path | What lives there |
|---|---|
| `src/core/` | Framework-free logic: print protocols and byte encoders, rasterisation and dithering, the element/label data model, templates and CSV, orientation. |
| `src/transport/` | Web Bluetooth and WebUSB. |
| `src/state/store.ts` | The app's single Zustand store. |
| `src/services/` | Print orchestration and user actions. |
| `src/ui/` | React components; `src/ui/stage/` is the canvas editor. |
| `src/i18n/` | English and Arabic dictionaries. |
| `docker/` | nginx + HTTPS packaging. |

The layering is deliberate: `src/core/` has no React and no browser APIs beyond
`canvas`, which is why it can be tested against a frozen copy of the original in
plain Node.

### Orientation, briefly

`LabelSize.orientation` sits next to `width`/`height`, which always stay the
literal physical millimetres. **Portrait** always means a tall canvas and
**Landscape** a wide one, built from the label's actual short and long sides — so
a 40×30 mm tape and a custom 30×100 mm label both support both orientations.
Switching rotates the composition as one piece (`rotateComposition`), and at
print time the artwork is rotated back onto the label's physical axes
(`rotatePixelsCW`) *before* the protocol pipeline — so `widthBytes`, DPI scaling
and printer-specific rotation never learn that orientation exists.

A design saved before this feature has no `orientation` field. Rather than
defaulting it to "portrait" — which could visually rotate a design that used to
render wide — `resolveOrientation` infers whichever orientation reproduces the
label's existing arrangement unchanged, so **old designs keep printing exactly as
they always did**.

---

## Credits and provenance

**This project is inspired by and derived from
[transcriptionstream/phomymo](https://github.com/transcriptionstream/phomymo)** —
an excellent browser-based label designer written in plain JavaScript. The
original established the hard parts: the Phomemo print protocols, the raster and
dithering pipeline, and the printer definitions. Phomymo Next rebuilds that work
as a typed, component-based application.

**Ported from the original:**

- `src/core/protocols/` and `src/core/printers/` — the print protocol and
  printer-definition logic, in TypeScript.
- `src/transport/` — Web Bluetooth and WebUSB.
- `tests/legacy/` — a frozen copy of the original, kept so the golden tests can
  assert byte-identical output.
- `tests/golden-*.test.ts` — 193 of the tests compare against that legacy code
  directly.

**New here:** the React component architecture, the TypeScript data model, the
Arabic/English interface, orientation support, and the Docker/HTTPS packaging.

The upstream README states an MIT licence but ships no `LICENSE` file. See
[NOTICE](NOTICE) for the full attribution, including the original project's own
protocol research (`vivier/phomemo-tools`, `yaddran/thermal-print`, and
reverse-engineering by `ooki1jp`).

If you want the upstream project itself, use
[transcriptionstream/phomymo](https://github.com/transcriptionstream/phomymo).

---

## Licence

Released under the [MIT Licence](LICENSE).

Copyright © 2026 Lojs

<p align="center">
  <sub>Made with patience, in Kuwait.</sub>
</p>