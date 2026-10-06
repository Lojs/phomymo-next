# Changelog

Every user-visible change, newest first. The history that used to live in the source comments —
"used to", "the earlier version", "the old code resumed..." — belongs here instead: in a comment it
goes stale the moment the code moves on, and it makes the reader work to find out what a function
actually does now.

The commits are the source of truth for anything more granular. Commit messages in this repository
carry the reasoning in full; this file is the index.

## 1.0.25

### Fixed
- **A photograph printed too light and too flat on a 300 DPI head.** An image was halftoned at the
  203 DPI authoring grid and then resampled up: `ditherPreview()` rendered the halftone at the
  element's size in label pixels, and the renderer drew it into a canvas scaled by 300/203 with
  smoothing on. Bilinear interpolation of a 1-bit image spreads each dot over its neighbours' grey,
  and the threshold that follows turns those greys into clumps. This is the same
  "203 DPI bitmap interpolated to 300" that 1.0.22 removed for the whole label, surviving inside
  images. Each image is now binarised at the resolution it will print at and drawn without
  smoothing, which is a 1:1 mapping.

  Measured in a browser on a photo-like source, mean tone error per band across the image's box:

  | | 203 DPI | 300 DPI |
  |---|---|---|
  | before | 0.0010 | 0.0475 |
  | after | 0.0010 | 0.0017 |

  203 DPI is unchanged, as it must be — nothing is resampled there. The bands before the fix read
  `92.5 83.2 69.9 55.9 41.1 28.6 18.6 12.0 6.8 3.0` against an ideal of
  `88.2 76.2 63.9 53.2 42.8 34.0 26.2 18.6 11.0 5.2`: darks darker, lights lighter, which is the
  contrast a smoothed halftone loses.

  The 1.0.24 notes said the 300 DPI image was "about 1 point lighter … accepted rather than papered
  over". A single ink total for the whole image hid a systematic mid-tone collapse — the 53% grey
  band was printing at 37% — so that was the wrong number to judge it by, and the wrong conclusion.

  **Not verified on paper.** A physical print on a 300 DPI head is the check that settles this, and
  the printer available here is 203 DPI (M221), where the code path does not change. The numbers
  above come from a real canvas, not from a real printer.
- **The CSV round trip lost data in three places.** Found by fuzzing the writer against the reader —
  3000 values over an alphabet built from every character that matters to either side.
  - A value the user's own data began with an apostrophe was silently edited: `'=SUM(1)` came out of
    a round trip as `=SUM(1)`. The reader trims every field before it strips the guard, and could not
    tell the user's quote from its own; a literal apostrophe is now escaped by doubling it, and
    exactly one level comes off on import.
  - A record whose every field was empty serialised to an empty line, which the reader treats as a
    blank line and drops — two rows in, none out. Such a row is now written `""`, which the reader
    already documents as an empty *cell*.
  - A header containing a literal tab or semicolon made the delimiter sniffer choose that character
    as the delimiter and split that header into two columns. The writer quoted commas, quotes and
    newlines but not those.
- **`npm audit` reported one high advisory** (source-map-js, reached only through the test tooling)
  and it is cleared. CI had no audit step at all; it now gates on `npm audit --omit=dev
  --audit-level=high` and prints the full audit for information, so a runtime advisory blocks a
  release and a build-only one cannot block it for the wrong reason.

### Changed
- **The offline cache now survives a release.** Cache names used to embed the per-build id, so
  `activate` discarded every cache on every release: the asset trim had nothing left to do, and
  chunks that had *not* changed went with it. pdf.js's worker, jsPDF and html2canvas keep the same
  hashed names between releases, so each update made the browser re-download roughly 2 MB — in an app
  whose point is that it opens with no network. The build id still changes the worker's bytes, which
  is what makes a browser install the update; the cache names are governed separately now, and the
  trim is what keeps them honest. Caches from 1.0.24 and earlier are removed on the first update.
- **Two rules that the design depends on now have tests, because removing them broke nothing.** The
  composite mode in `rasterFor()` — the single argument that 1.0.22 and 1.0.24 turn on — could be
  changed from `threshold` to `auto` and the whole suite still passed, its test having been deleted
  along with the `modeFor()` it replaced. The same was true of the build's refusal to ship an
  unstamped service worker. Both mutations now fail the suite.
- **The build stamps every occurrence of its token.** It replaced the first only, while the guard
  above it checked `includes()` — so a second mention would have shipped as a literal placeholder
  with the guard satisfied.

### Notes
- The rationale comments for the container's certificate mount, capabilities and tmpfs are back,
  written from what the entrypoint does rather than from memory.
- The `compose.yaml` and `README.md` simplification of 1.0.24 stands; only the load-bearing reasons
  were restored.

## 1.0.24

### Fixed
- **The service worker was never replaced.** Its cache name was a constant — `phomymo-v3`, then `v2` —
  so a browser that had installed one version kept that worker and its cached assets for as long as
  the string did not change. A build now stamps the worker with an id derived from the build's own
  content, and **the build fails if the stamp is missing**, so a worker that cannot change cannot
  ship. The trimming that removes dead hashed assets runs in `activate`, which is only reached when
  the worker is replaced — so that fix had been inert in every release containing it.
- **An image whose type the browser reports as empty disappeared on the next load.** A file with no
  usable MIME type is read as `data:application/octet-stream;base64,…`, and the guard required
  `data:image/`, so the element displayed and printed and was then filtered out silently when the
  design was reopened, with no message. The requirement was always "no network URL": any `data:` URL
  is accepted now, and `https:`, `//`, `javascript:`, `blob:` and `file:` are still refused.
- **An exported CSV header could carry a live formula.** Field names come from the design file, so an
  imported template controls them, and the header row went out through a plain CSV escaper while
  every data row was guarded. Headers are guarded now — and unguarded on the way back in, because
  guarding one side only would have made a field name gain an apostrophe on every round trip and
  stop matching the template that refers to it.
- **A value typed with its own leading apostrophe came back edited.** `'=SUM(1)` returned as
  `=SUM(1)`, because import stripped any leading quote followed by a formula character and could not
  tell the user's quote from its own guard. A literal apostrophe is now escaped by doubling it, and
  exactly one level is removed on import, so the round trip is lossless.
- **One save in another tab produced one error toast.** The other tab autosaves on every edit, so a
  busy minute stacked dozens of identical toasts over everything else on screen. One warning per key
  per minute now: the condition cannot change between them, so the tenth said nothing the first did
  not.
- **A saved design was trusted where an autosave was repaired.** `loadDesign()` clamped the label size
  and filtered the elements, then cast the multi-label grid and the template rows straight through —
  so a saved design with `labelsAcross: 0` reached the layout code that divides by it, purely because
  it had arrived as a saved design rather than an autosave. Both loaders share one repair now.
- **The dithering control claimed more than it knew.** An image with no explicit choice was resolved
  by a heuristic, while the button named one of the four algorithms. **Automatic** is a real, listed
  value and the one an unset image shows: it names the setting, which is what can be named honestly.
- **A picture no longer drags the text beside it into a halftone.** The rule "threshold unless the
  label contains an image" went back onto the photo heuristic as soon as any image was present, so a
  logo put the whole label, text included, through error diffusion. Each image is now binarised as it
  is drawn and the composite is always a plain threshold. That also deletes the two functions that
  decided a label-wide mode.

  Measured on a label holding a photographic image and a line of Arabic, old path against new, in a
  browser at 203 and 300 DPI: the image keeps its tone (29.02% → 29.01% ink at 203 DPI, 28.97% →
  28.02% at 300) and the text gains about 6% ink from the threshold keeping its antialiased edges.
  Isolated dots: **0 in both**. So the structure is right — an image's setting now applies to the
  image — but the visible benefit is smaller than the premise suggested, and 1.0.22's "two
  independent causes" overstated the dithering's share: the speckle it measured needed the 203→300
  upscale as well, and that is already gone.

### Changed
- A menu decides whether to open upward against the nearest ancestor that clips it rather than the
  window. Measured at 390×700 and 900×620: the app's panel reaches the window's bottom in both
  layouts and its menus are 42–44 px, so no case was found where the two disagree. This is hardening
  of the measurement, not a fix for a demonstrated failure.
- Two comments corrected to match the code. `teardown()` claimed all three paths out of a connection
  went through it while two do — the third, a spontaneous drop, is deliberately elsewhere because it
  is the only case that marks the drop unexpected. The matching line in 1.0.19 said the same and was
  corrected with it.

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
  offering the device chooser. Teardown is now one function, used by both paths a user can take out
  of a connection. A spontaneous drop keeps its own handler, because it is the only case that marks
  the drop as unexpected.
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
