# Fonts for backend PDF exports

The shared PDF renderer at `server/services/files/pdf.js` will use Unicode
`.ttf` fonts from THIS directory when present, and fall back to PDFKit's
built-in Helvetica when they are not. Devanagari (Marathi / Hindi) characters
render as tofu boxes in Helvetica, so you must drop the four files below to
enable Marathi in exported PDFs.

## Files this repo looks for

Drop any of the following files into `server/assets/fonts/`. Each file is
optional; whatever is present will be used, and missing ones fall back to
Helvetica.

| Filename                          | Purpose                              |
| --------------------------------- | ------------------------------------ |
| `NotoSans-Regular.ttf`            | Regular body text (Latin + basic UI) |
| `NotoSans-Bold.ttf`               | Bold body text                       |
| `NotoSansDevanagari-Regular.ttf`  | Marathi / Hindi text                 |
| `NotoSansDevanagari-Bold.ttf`     | Marathi / Hindi bold                 |

If only the Devanagari pair is present, both are used for the whole document
— Noto Sans Devanagari includes Latin glyphs, so the report still reads
correctly for English column headers.

## Where to get them (all SIL OFL, free for commercial use)

- Noto Sans:              <https://fonts.google.com/noto/specimen/Noto+Sans>
- Noto Sans Devanagari:   <https://fonts.google.com/noto/specimen/Noto+Sans+Devanagari>

Or npm:

```
npm i @fontsource/noto-sans @fontsource/noto-sans-devanagari
cp node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.ttf                    server/assets/fonts/NotoSans-Regular.ttf
cp node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.ttf                    server/assets/fonts/NotoSans-Bold.ttf
cp node_modules/@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-400-normal.ttf  server/assets/fonts/NotoSansDevanagari-Regular.ttf
cp node_modules/@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-700-normal.ttf  server/assets/fonts/NotoSansDevanagari-Bold.ttf
```

## Do the .ttf files belong in git?

Prefer NOT — .ttf blobs bloat the repo. Add a step to the deploy pipeline
(or a `postinstall` script) that copies them from `@fontsource/*` into this
directory. Add `*.ttf` to `.gitignore` here to keep the tree lean, but
leave THIS README committed so the requirement is discoverable.
