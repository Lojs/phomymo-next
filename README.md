# Phomymo Next

A label designer for Phomemo thermal printers — text, images, barcodes, QR
codes, shapes, multi-label rolls and CSV/template batch printing — printed
straight from the browser over Bluetooth or USB. A React + TypeScript
rewrite with an Arabic/English interface.

![Phomymo Next — the label designer, editing a 60×40 mm product label](docs/screenshots/desktop-en.png)

<table>
<tr>
<td width="70%"><img src="docs/screenshots/desktop-ar.png" alt="Arabic RTL interface"></td>
<td width="30%"><img src="docs/screenshots/mobile.png" alt="Mobile layout"></td>
</tr>
<tr>
<td align="center"><sub>The same app in Arabic — full RTL layout</sub></td>
<td align="center"><sub>Phone layout</sub></td>
</tr>
</table>

## Credits and provenance

**This project is inspired by and derived from
[transcriptionstream/phomymo](https://github.com/transcriptionstream/phomymo)**
— an excellent browser-based label designer written in plain JavaScript. The
original established the hard parts: the Phomemo print protocols, the raster
and dithering pipeline, and the printer definitions. Phomymo Next rebuilds
that work as a typed, component-based application.

What came from the original:

- `src/core/protocols/` and `src/core/printers/` — the print protocol and
  printer-definition logic, ported to TypeScript.
- `src/transport/` — Web Bluetooth and WebUSB handling, ported.
- `tests/legacy/` — a frozen copy of the original implementation, kept so the
  golden tests can assert that this rewrite produces byte-identical output.
- `tests/golden-*.test.ts` — 193 of the 255 tests compare against that legacy
  code directly.

What is new here: the React component architecture, the TypeScript data model,
the Arabic/English interface, orientation support, and the Docker/HTTPS
packaging.

The original project's README states an MIT licence but ships no `LICENSE`
file; see [LICENSE](LICENSE) for this project's licence and
[NOTICE](NOTICE) for the full attribution, including the upstream's own
protocol research (`vivier/phomemo-tools`, `yaddran/thermal-print`, and
reverse-engineering by `ooki1jp`).

If you want the upstream project itself, use
[transcriptionstream/phomymo](https://github.com/transcriptionstream/phomymo).

## Requirements

Bluetooth and USB printing use the Web Bluetooth / WebUSB APIs, which only
work in **Chrome or Edge**, and only in a **secure context** — HTTPS, or
`http://localhost`. That's why the Docker image below serves the app over
HTTPS by default.

## Run it with Docker (recommended)

### Quick start

```sh
cp .env.example .env        # then edit PHOMYMO_DOMAIN if needed — see below
docker compose up -d --build
```

Then open **https://localhost:8444** on this machine, or
**https://\<this-machine's-LAN-IP\>:8444** from any other device on your
network (phone, another computer, etc.) — Docker Compose publishes the
port on all network interfaces by default, so nothing extra is needed for
LAN access.

The stack publishes a **single port** (`8444:443`). The app only works in a
secure context, so there is no plain-HTTP port to redirect from — always use
`https://` and the `8444` port explicitly.

### Accessing it from other devices on your network

1. Find this machine's LAN IP (e.g. `192.168.1.50`) — `hostname -I` on
   Linux, or check your router.
2. Put that IP in `.env`:
   ```
   PHOMYMO_DOMAIN=192.168.1.50
   ```
3. `docker compose up -d --build` (or just restart if already running, see
   below) so the certificate is regenerated for that address.
4. From another device on the same network, open
   `https://192.168.1.50:8444`.

The container generates a self-signed certificate on first start, so your
browser will show a security warning — that's expected for a self-signed
cert; click through it once (usually "Advanced" → "Proceed") and the
origin counts as secure from then on, which is what Bluetooth/USB
printing need.

**Using your own certificate instead of the self-signed one:** copy
`cert.pem` and `key.pem` into the `phomymo-certs` volume, then restart:

```sh
docker compose cp ./cert.pem phomymo-next:/certs/cert.pem
docker compose cp ./key.pem  phomymo-next:/certs/key.pem
docker compose restart
```

If both files are already there on startup, the self-signed one is never
generated.

### Commands

| Action | Command |
|---|---|
| Build the image | `docker compose build` |
| Start the container (builds if needed) | `docker compose up -d --build` |
| Start without rebuilding | `docker compose up -d` |
| Stop the container | `docker compose down` |
| View logs | `docker compose logs -f` |
| Rebuild after changing source code | `docker compose up -d --build` |
| Check it's running | `docker compose ps` |
| Full reset (also drops the cert volume) | `docker compose down -v` |

### Persistent storage

The **only** thing persisted server-side is the HTTPS certificate
(`phomymo-certs` volume, mounted at `/certs`), so it survives container
restarts and rebuilds instead of showing a fresh browser warning every
time. Everything else — designs, settings, printer memory, template data
— lives in the browser's `localStorage` on each device that opens the
app; the server is stateless otherwise, and running `docker compose down`
(without `-v`) never touches that.

## Local development

```sh
npm install
npm run dev        # http://localhost:5173 — localhost counts as secure, so BLE/USB work here too
npm run build       # production build to dist/
npm test            # unit + golden tests against the original app's logic
npm run typecheck
```

## Project layout

- `src/core/` — framework-free logic: printer protocols and byte encoders,
  image rasterisation/dithering, the element/label data model, templates
  and CSV, label rendering, and orientation (Portrait/Landscape — see
  below). Fully unit-tested against the original app's behaviour
  (`tests/golden-*.test.ts`) plus new tests for geometry and orientation.
- `src/transport/` — Web Bluetooth and WebUSB, ported from the original.
- `src/state/store.ts` — the app's single Zustand store.
- `src/services/` — printing orchestration and user actions (add/import/export).
- `src/ui/` — React components; `src/ui/stage/` is the canvas editor.
- `src/i18n/` — English and Arabic dictionaries.
- `docker/` — nginx + HTTPS packaging.

## Orientation (Portrait / Landscape)

Rectangular, non-square labels can be designed in Portrait or Landscape.
The physical label size you pick is never rewritten — orientation only
changes how the design sits on it:

- `LabelSize.orientation` (`'portrait' | 'landscape'`) lives next to
  `width`/`height`, which always stay the literal physical mm values.
- **Portrait always means the canvas is tall** (width ≤ height) and
  **Landscape always means wide** (width ≥ height) — true regardless of
  which physical dimension the label happens to call "width". A 40×30mm
  tape preset and a custom 30×100mm label both support both orientations,
  built from the label's actual short/long sides
  (`resolveOrientation`/`displayLayout` in `core/render/layout.ts`).
- Switching orientation on a label that already has elements rotates the
  whole design 90° as one composition (`rotateComposition` in
  `core/model/elements.ts`) — nothing is reset, element sizes are kept,
  only positions and each element's own rotation update.
- At print/preview time, the rendered artwork is rotated back onto the
  label's physical axes (`rotatePixelsCW` in `core/render/orient.ts`)
  *before* it reaches the existing protocol/raster pipeline — so
  `widthBytes`, DPI scaling, and printer-specific rotation (e.g. D-series)
  are completely unaware orientation exists and needed no changes.
- Not applicable to round labels, square labels, or multi-label rolls —
  the control is hidden for those.

**Backward compatibility:** a design saved before this feature has no
`orientation` field. Rather than defaulting that to a literal "portrait"
(which could visually rotate a design that used to render wide),
`resolveOrientation` *infers* whichever orientation reproduces the
label's existing width/height arrangement unchanged — so old designs
keep printing exactly as they always did. Any explicit choice you make
afterwards is stored and takes over from there.

