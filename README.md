# csv-reader-speed — a faster drop-in for csv-reader 1.0.0

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/mrmasudhafej-tech/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/mrmasudhafej-tech/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/competitions/csv-reader-speed-01-run-20261121)

A faster drop-in replacement for make.fun's own csv-reader 1.0.0, written for the
[csv-reader-speed-01-run-20261121](https://make.fun/competitions/csv-reader-speed-01-run-20261121)
bounty. `solve.js` exports `run(input)`, which returns exactly csv-reader's answer
`{columns, rows, errors}` for every input `{text, header}` — including its broken-row
policy (stray CRs, quote junk, unterminated quotes, short/long rows, multi-line quoted
fields, BOM, CRLF). `main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## Speed approach

The reference reads one character at a time and builds every field by string
concatenation. This reader works in slices found with `indexOf` instead:

- **Fast path — records with no quote.** Most records hold no quote at all, and one
  record is one physical line, so the line is sliced out with a single `indexOf('\n')`
  and, when it holds no quote, `split(',')` gives the fields at once. A CRLF terminator
  is stripped first; stray CRs are stripped per field with their `stray_cr` errors.
  No per-character loop, no per-field concatenation.
- **Slow path — records holding a quote.** Only these are read field by field, and each
  field is still read in slices: an unquoted field runs to the next comma or line break
  found by `indexOf`, a quoted field runs to its closing quote found by `indexOf('"')`,
  with doubled quotes folded in as segments joined once. Line breaks inside quoted
  fields are counted per segment with bounded `indexOf` scans, so error line numbers
  stay exact.

Nothing is cached between cases: every call reads its own text from scratch.

## Verification

Checked against csv-reader 1.0.0 itself on the kit's practice set (6 cases,
~10.3 MB of CSV): every answer byte-identical (columns, rows, errors), the kit's
own scorer passes 6/6, and the practice-set run is ~3.7–4.1x faster than the
baseline on parse CPU time (~1.96x end to end including JSON I/O). See
`results/csv-reader-speed-01-run-20261121/BUILD-LOG.md` in the build workspace for
the exact numbers. A random fuzz check over 20,000 nasty hand-built inputs
(empty text, lone CRs, unterminated quotes, quote junk, CRLF mixes, empty lines)
also matches the reference exactly.

## Layout

- `solve.js` — the fast reader (`run`)
- `main.ts` — the harness driver
- `LICENSE` — MIT
