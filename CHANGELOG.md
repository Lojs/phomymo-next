# Changelog

Every user-visible change, newest first. The history that used to live in the source comments —
"used to", "the earlier version", "the old code resumed..." — belongs here instead: in a comment it
goes stale the moment the code moves on, and it makes the reader work to find out what a function
actually does now.

The commits are the source of truth for anything more granular. Commit messages in this repository
carry the reasoning in full; this file is the index.

## 1.0.23

### Changed
- **The image dithering control now says what each choice does, and shows you the result.** It used
  to list four algorithm names — "None (threshold)", "Ordered (Bayer)", "Atkinson",
  "Floyd–Steinberg" — which told you nothing about which one suited a photograph. The choices are
  now **Grayscale 256**, **Standard**, **Light dots** and **Black & white**, in that order (the one
  meant for a photo first), each with its algorithm name kept as a small hint beside it so nothing
  is lost. The trigger names the mode that will actually print: an image with no explicit choice
  prints as Floyd–Steinberg, so it reads "Grayscale 256" rather than "None".
- The list is **text only**. A 52×34 preview of the image was added to every row and then removed
  at the user's request, so the algorithm name hint is the only second line.

### Fixed
- **A menu opened by a control low in a short window could render its last rows below the viewport
  with no way to reach them.** Measured: the four-row dithering picker opened at y=403 in a 577px
  window, ended at 613, and its fourth option could not be clicked at all. A native `<select>` is
  repositioned by the browser; a popup built from a div is not, so `MenuButton` now measures after
  mount and opens upward when it would overflow and there is room above. This applies to every menu
  in the app, not only this one.
- A menu item whose thumbnail had not loaded yet (`null`, as opposed to no thumbnail at all) made
  the menu fall back to its narrow width, so the pictures arrived into a menu sized for text alone.

## 1.0.22

### Fixed
- **Printed text came out speckled, hollow and fuzzy while the same design looked clean on screen.**
  Two independent causes, both measured on the raster that reaches the printer before either was
  changed:
  - The print path asked for the `auto` dithering mode, and the ported `shouldUseDithering`
    heuristic answers "yes, dither" for any artwork with more than 50 distinct colours. Antialiased
    glyph edges supply 199, so **every text label was being halftoned like a photograph**. Error
    diffusion scatters those soft edges: a text-only label produced **453 isolated single dots**,
    where a plain threshold produces none, with eroded interiors to match. Text, barcodes and
    shapes are line art and are now thresholded; dithering stays available the moment the label
    actually contains an image. The `shouldUseDithering` function itself is untouched — it is a
    faithful port of the original and `tests/golden-raster-templates.test.ts` pins it bit-for-bit.
  - A **300 DPI head was fed 203 DPI artwork interpolated up.** Every coordinate in the app is on
    an 8 px/mm (203 DPI) grid, so the label was rendered at 203 DPI and the finished bitmap was
    then resampled to 300. Measured on a 53 mm M02 Pro label, **6954 of ~8855 ink dots landed on a
    different dot** than a native render, and glyph edges came out rounded and wavy — interpolation
    cannot invent detail the original render never had. High-DPI heads are now rendered at their
    own resolution. The artwork's pixel dimensions are unchanged either way, so nothing downstream
    — byte counts, row counts, the encoder — can shift because of this.

### Notes
- Verified on the real pipeline in a browser, not by inspection: the corrected raster for a
  text-only label on an M02 Pro measures 0 isolated dots, and 300 DPI output is produced from a
  single canvas instead of three.
- If your printer is 203 DPI (T02, M03), only the first fix applies to you — and it is the larger
  of the two. On a 300 DPI head (M02 Pro, M04S) both apply.
- A printed barcode was unaffected throughout: its bars are solid black with hard, axis-aligned
  edges, and error diffusion leaves solid regions solid. Only thin antialiased strokes — Arabic
  text in particular — were damaged.

## 1.0.21

### Removed
- Dependabot. It opened a branch and a pull request for every GitHub Action; the repository keeps a
  single branch instead. The Actions stay pinned to the commit SHAs recorded as comments in the
  workflow, and `scripts/resolve-action-sha.mjs` re-resolves them by hand.

## 1.0.20

### Added
- The container prints its certificate fingerprint on every start, and the README explains how to
  compare it with the browser's certificate viewer. Until now the browser's self-signed warning was
  the only defence against an imposter on the network serving modified JavaScript, and the owner
  had no way to tell our certificate from a substituted one.
- A warning when another tab on the same origin writes to storage. Two tabs — or a tab and the
  installed PWA window — share localStorage, and both the autosave and the saved designs are
  last-writer-wins, so work could disappear silently.
- Exported CSV cells are neutralised against spreadsheet formula injection, and the guard is removed
  again on import so a round trip is lossless.
- ~~Dependabot, so the pinned GitHub Actions and npm dependencies stay current.~~ Removed in
  1.0.21: it opened a branch and a pull request for every action, and a repository with one branch
  is easier to reason about than one with six. The Actions stay pinned to the commit SHAs recorded
  as comments in the workflow, and `scripts/resolve-action-sha.mjs` re-resolves them by hand.
- This file.

### Fixed
- A `null` `labelSize` from a corrupt autosave or a damaged storage write no longer takes the app
  down at startup.

### Changed
- Test files are named for the behaviour they cover rather than for the review round that prompted
  them, so they can be found by subject.
- Comments that narrated a fix were moved here. Comments that explain *why* the code is the way it
  is stayed — those are the ones that are still true next year.

## 1.0.19

### Fixed
- The service worker never removed dead hashed assets. The trimming added in 1.0.18 kept every entry
  it found under `/assets/`, which made the rule a tautology — the only things it could delete were
  icons. A build now emits an asset manifest the worker reads, so anything the current build does not
  ship is removed.
- Abandoning a connection — the unanswered model dialog from 1.0.17 — cleared the state without ever
  disconnecting. The radio link stayed up while the interface said "disconnected": the printer
  remained occupied by that tab, and the next Connect silently reused the old printer instead of
  offering the device chooser. Teardown is now one function used by all three paths.
- An imported image element accepted any string as `imageData`, so a hostile design file could make
  the browser contact an attacker's server with the user's IP address and a query string of the
  attacker's choosing. The shipped CSP blocks it; `npm run dev` and any other host do not.
- The 25 MB import limit was thrown with a message naming the file and the limit, and the image
  import paths swallowed it for a generic "could not read that image".
- Printer-reported values were displayed verbatim: `1a 04 ff` showed "255%", and a malformed frame
  could produce a 500-character serial number.
- A non-finite density fell back to byte 128, which is the middle of a byte but not of the 1–8 range
  density actually lives in.
- The README said printing works over USB on Windows. It does not: Windows binds the printer to a
  kernel-mode print driver, and no browser can claim the interface afterwards.

### Changed
- The five `BLETransport` handles are typed. This removes a property the transport was writing onto
  the browser's own `BluetoothDevice`, and makes `send()` throw "Not connected" instead of a
  `TypeError`.
- The service worker and entrypoint are now executed in tests rather than grepped. The text-based
  assertions passed whether or not the code they named was reachable — which is how the cache bug
  above survived a full review.

## 1.0.18

### Fixed
- The service worker asset cache is trimmed on activate, and its cache writes are awaited rather
  than fired off — a floating promise can be lost when the worker is terminated.
- CI and the Dockerfile disagreed about Node (24 versus 22), so a green run verified a toolchain
  the released image never used.
- All GitHub Actions are pinned to commit SHAs with the version kept as a comment, so a mutable tag
  cannot be repointed at different code.
- The maskable icon was the same file as the ordinary icon, so Android's launcher cropped the
  artwork with no safe zone. The apple-touch icon is now the 180 px iOS asks for.

## 1.0.17

### Fixed
- A print is cancelled when the model picker is left unanswered, instead of going out on a guessed
  dpi and encoding for a machine nobody identified.
- The `expect` filter on wait operations was removed. It was plumbed through three layers and never
  passed by any caller, so the handshake problem its comment described was never actually solved.
- Single-byte protocol fields are bounded; a NaN became 0 on the wire and a value past 255 wrapped.
- Multi-label sizes are bounded, not just the zone count.
- PNG and PDF export use the same canvas guard as printing.
- Image, PDF, CSV and design imports have a 25 MB limit.
- The release gate passes the tag through `env:` rather than interpolating it into a shell script.

## 1.0.16

### Fixed
- The too-wide warning converts through the printer's own DPI. At 300 DPI the M02 Pro read "78mm"
  when the paper is 53 mm.
- That warning fires once per print job rather than once per label in a batch.
- The README claimed Chrome and Edge on macOS cannot print. They can; the app gates on feature
  detection alone.
- `describe()` keeps its "mm" unit for an unrecognised printer.
- The width warning compares and displays the same value, so it can no longer say a 53 mm label does
  not fit a printer that "prints 53mm".
- A failed GATT setup no longer fires the disconnect handler mid-connect.
- Abort listeners are released per operation.
