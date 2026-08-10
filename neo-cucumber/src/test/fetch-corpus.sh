#!/bin/sh
# Fetches the replay files listed in corpus.manifest.txt from the public
# bucket. They are real drawings, so they are not committed; the corpus test
# skips itself when they are absent.
set -e
dir="$(dirname "$0")"
mkdir -p "$dir/corpus"
while read -r name; do
  [ -z "$name" ] && continue
  [ -f "$dir/corpus/$name" ] && continue
  curl -sfL --max-time 30 \
    "https://r2.oeee.cafe/replay/$(echo "$name" | cut -c1-2)/$name" \
    -o "$dir/corpus/$name"
done < "$dir/corpus.manifest.txt"
echo "corpus ready: $(ls -1 "$dir/corpus" | wc -l) files"
