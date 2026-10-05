# Changelog

Every user-visible change, newest first. The history that used to live in the source comments —
"used to", "the earlier version", "the old code resumed..." — belongs here instead: in a comment it
goes stale the moment the code moves on, and it makes the reader work to find out what a function
actually does now.

The commits are the source of truth for anything more granular. Commit messages in this repository
carry the reasoning in full; this file is the index.

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
- Dependabot, so the pinned GitHub Actions and npm dependencies stay current.
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
