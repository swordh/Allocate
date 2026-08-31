# Self-hosted fonts

Both typefaces are self-hosted deliberately — the design handoff requires it.
Never load either from Google Fonts or Fontshare at runtime.

| File | Family | Role | CSS variable |
|---|---|---|---|
| `GeneralSans-Variable.woff2` + `-VariableItalic.woff2` | General Sans | UI: nav, labels, buttons, body copy | `--font-sans` → `--font-ui` |
| `Archivo-Variable.woff2` | Archivo | Display: large page headings, numbers, table values | `--font-display` → `--font-heading` |

Both are registered with `next/font/local` in `app/layout.tsx`. Components
should reference `--font-ui` / `--font-heading` from `app/globals.css`, never
`--font-sans` / `--font-display` directly.

## Regenerating Archivo

Source: [google/fonts `ofl/archivo`](https://github.com/google/fonts/tree/main/ofl/archivo),
SIL Open Font License 1.1 (`Archivo-OFL.txt`).

Upstream ships a two-axis variable font (`wght` 100–900, `wdth` 62–125). We pin
the width axis and clamp the weight range to what the design uses, then subset
to latin + latin-ext. Requires `fonttools` and `brotli`.

```bash
curl -sL -o Archivo.ttf \
  "https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/Archivo%5Bwdth,wght%5D.ttf"

python3 -m fontTools.varLib.instancer Archivo.ttf wdth=100 wght=400:800 \
  -o Archivo-inst.ttf

python3 -m fontTools.subset Archivo-inst.ttf \
  --output-file=Archivo-Variable.woff2 --flavor=woff2 \
  --layout-features='*' --no-hinting --desubroutinize \
  --unicodes="U+0000-00FF,U+0100-024F,U+0259,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+1E00-1EFF,U+2000-206F,U+2074,U+20A0-20C0,U+2113,U+2122,U+2191,U+2193,U+2212,U+2215,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD"
```

Result: 704 glyphs, ~57 KB, `wght` 400–800. latin-ext is included because
Archivo renders user-entered data (project, company and crew names) in tables —
a mid-word fallback to General Sans there reads as a rendering bug.

We subset ourselves rather than using the files Google's `css2` API serves,
because those are split per subset with `unicode-range`, and `next/font/local`
has no `unicodeRange` field in its `src` entries.
