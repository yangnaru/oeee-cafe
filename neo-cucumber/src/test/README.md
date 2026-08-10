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

The files are real drawings, so they are not committed. `corpus.manifest.txt`
lists them; fetch them from the public bucket with:

```bash
src/test/fetch-corpus.sh
```

Without them the corpus suite reports itself skipped rather than passing
silently.

Restore frames are dropped before comparing. They carry the finished drawing as
a PNG, so applying them would overwrite the replayed strokes and make the
comparison pass no matter how the strokes rendered.
