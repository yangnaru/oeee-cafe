# Test fixtures

## Fidelity to NEO

`neoHarness.ts` loads the canonical PaintBBS NEO implementation
(`neo/src/painter.js`) into the test page, so the TypeScript port in `src/neo`
is checked against the real thing rather than against a description of it.

## Replay corpus

`corpus.browser.test.ts` replays real production `.pch` files through both
implementations and asserts the layers come out pixel-identical. This is the
test that matters: a replay that renders differently from the drawing it was
recorded from is the worst failure this codebase can produce.

`corpus.manifest.txt` lists every live `.pch` in the archive. The drawings
themselves are not committed; fetch them with:

```bash
src/test/fetch-corpus.sh
```

That pulls ~145 MB and makes `pnpm test` take several minutes, so it is
deliberately opt-in. Without the files the corpus suite reports itself skipped
rather than passing silently. To work against a smaller sample, trim
`corpus.manifest.txt` or delete files from `corpus/` — the suite globs whatever
is present.

Refresh the manifest from the database with:

```sql
SELECT replay_filename FROM images
WHERE deleted_at IS NULL AND replay_filename LIKE '%.pch';
```

### What the sweep asserts

Restore frames are dropped before comparing. They carry the finished drawing as
a PNG, so applying them would overwrite the replayed strokes and make the
comparison pass no matter how the strokes rendered.

One archived file still cannot be decoded: a zero-byte upload whose recorded
filename is the SHA-256 of the empty string. It is asserted by name, so a
second such file fails the suite rather than hiding.

A second file used to fail too — two frames concatenated, leaving a
`"freeHand"` header where a coordinate belongs, which made NEO pass `NaN` to
`getImageData` and throw. It was repaired in the bucket rather than worked
around in the decoder, so the live NEO viewer plays it again as well. Both were
written by the standalone `cucumber` app that neo-cucumber replaced in October
2025 (`ca244d4`), not by anything still in the tree.
