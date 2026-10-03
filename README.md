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

## Table of contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Accessing it from your phone](#accessing-it-from-your-phone)
- [Commands](#commands)
- [Where your data lives](#where-your-data-lives)
- [Local development](#local-development)
- [Project layout](#project-layout)
- [Credits and provenance](#credits-and-provenance)
- [Licence](#licence)

---

## What it does

- **Real label sizes.** 12 preset sizes plus round labels, continuous tape, and
  any custom size you enter in millimetres. The size you pick is the paper
  that's actually in the printer — orientation never rewrites it.
- **Portrait and Landscape** on any rectangular label. Switching rotates your
  whole design 90° as one piece; nothing is reset.
- **Print over Bluetooth or USB**, with the paper width, DPI, and alignment
  taken from the printer model (18 built-in definitions, plus your own).
- **Batch printing from CSV or a template table** — one design, many records,
  with fields and expressions like `[[date]]`.
- **Print preview** that shows images as they will actually dither on paper,
  while keeping text and barcodes crisp.
- **Import / export** designs as JSON, PNG, or PDF.
- **Arabic and English**, with a full right-to-left layout.

---

## Requirements

Bluetooth and USB printing use the Web Bluetooth / WebUSB APIs, which work
**only in Chrome or Edge**, and **only in a secure context** — HTTPS, or
`http://localhost`. That is why the Docker image serves the app over HTTPS.

---

## Quick start

```sh
cp .env.example .env        # edit PHOMYMO_DOMAIN if you need LAN access
docker compose up -d --build
```

Then open **https://localhost:8444**.

The stack publishes a **single port** (`8444:443`). There is no plain-HTTP
port to redirect from, so always use `https://` and the port explicitly.

---

## Accessing it from your phone

Docker Compose publishes the port on all interfaces, so any device on your
network can reach it — you only need to tell the container which address to
put in its certificate.

1. Find this machine's LAN IP — `hostname -I` on Linux, or check your router.
2. Put it in `.env` (optional — without it the app assumes `localhost`, which
   works for a local trial):
   ```sh
   PHOMYMO_DOMAIN=192.168.1.50
   ```
3. Restart so the certificate is regenerated for that address:
   ```sh
   docker compose up -d
   ```
4. On your phone, open **https://192.168.1.50:8444**.

The container generates a **self-signed certificate** on first start, so your
browser will warn once — that is expected. Click through it ("Advanced" →
"Proceed"); the origin counts as secure from then on, which is what Bluetooth
and USB printing need.

<details>
<summary>Using your own certificate instead</summary>

Copy `cert.pem` and `key.pem` into `./phomymo-certs/` on the host and restart:

```sh
cp ./cert.pem ./phomymo-certs/cert.pem
cp ./key.pem  ./phomymo-certs/key.pem
docker compose restart
```

`./phomymo-certs` is a **bind mount**, not a named volume, so the files are plain
files you can read, replace or back up — and `docker compose down -v` leaves
them alone. If both files exist at startup the self-signed one is not generated,
and a `domain` file records which address they were issued for: change
`PHOMYMO_DOMAIN` and the certificate is regenerated on the next start, rather
than leaving a certificate that now reports a name mismatch.

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
| Rebuild after changing source | `docker compose up -d --build` |
| Check it's running | `docker compose ps` |
| Full reset | `docker compose down` |
| Reset including the certificate | `rm -rf phomymo-certs && docker compose up -d` |

---

## Where your data lives

The **only** thing persisted server-side is the HTTPS certificate, in
`./phomymo-certs` on the host (mounted at `/certs`). It survives restarts and
rebuilds instead of showing a fresh browser warning every time, and it warns on
startup if it is within 30 days of expiry. Because it is a bind mount,
`docker compose down -v` does **not** remove it.

Everything else — your designs, settings, printer memory, template data —
lives in the browser's `localStorage` on each device that opens the app. The
server is stateless otherwise, so `docker compose down` never touches it.

---

## Local development

```sh
npm install
npm run dev         # http://localhost:5173 — localhost counts as secure, so BLE/USB work here too
npm run build       # production build into dist/
npm test            # unit + golden tests against the original app's logic
npm run typecheck
```

### Tests

**1078 tests** across 39 files. A core of them are **golden tests**: they compare this
rewrite's output byte-for-byte against a frozen copy of the original implementation
in `tests/legacy/`, so a refactor can't quietly change what reaches the paper.

`npm test` runs the suite; `npm run typecheck` and `npm run build` are separate, and
CI runs all three before anything is published. Two places deliberately diverge from
the legacy behaviour — a CSV file that is empty is reported as empty instead of
parsing as one nameless column, and a malformed CSV row is reported by its real line
number — and both are asserted explicitly rather than left to drift. See
`tests/golden-raster-templates.test.ts` for what each one changed and why.

---

## Project layout

| Path | What lives there |
|---|---|
| `src/core/` | Framework-free logic: print protocols and byte encoders, rasterisation and dithering, the element/label data model, templates and CSV, and orientation. Unit-tested against the original behaviour. |
| `src/transport/` | Web Bluetooth and WebUSB. |
| `src/state/store.ts` | The app's single Zustand store. |
| `src/services/` | Print orchestration and user actions. |
| `src/ui/` | React components; `src/ui/stage/` is the canvas editor. |
| `src/i18n/` | English and Arabic dictionaries. |
| `docker/` | nginx + HTTPS packaging. |

### Orientation, briefly

`LabelSize.orientation` sits next to `width`/`height`, which always stay the
literal physical millimetres. **Portrait** always means a tall canvas and
**Landscape** a wide one, built from the label's actual short and long sides —
so a 40×30 mm tape and a custom 30×100 mm label both support both
orientations. Switching rotates the composition as one piece
(`rotateComposition`), and at print time the artwork is rotated back onto the
label's physical axes (`rotatePixelsCW`) *before* the protocol pipeline — so
`widthBytes`, DPI scaling, and printer-specific rotation never learn that
orientation exists.

A design saved before this feature has no `orientation` field. Rather than
defaulting it to "portrait" — which could visually rotate a design that used
to render wide — `resolveOrientation` infers whichever orientation reproduces
the label's existing arrangement unchanged, so **old designs keep printing
exactly as they always did**.

---

## Credits and provenance

**This project is inspired by and derived from
[transcriptionstream/phomymo](https://github.com/transcriptionstream/phomymo)** —
an excellent browser-based label designer written in plain JavaScript. The
original established the hard parts: the Phomemo print protocols, the raster
and dithering pipeline, and the printer definitions. Phomymo Next rebuilds
that work as a typed, component-based application.

**Ported from the original:**

- `src/core/protocols/` and `src/core/printers/` — the print protocol and
  printer-definition logic, in TypeScript.
- `src/transport/` — Web Bluetooth and WebUSB.
- `tests/legacy/` — a frozen copy of the original, kept so the golden tests can
  assert byte-identical output.
- `tests/golden-*.test.ts` — 193 of the 1078 tests compare against that legacy
  code directly.

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