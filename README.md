# site-generator-fast

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mazireal/site-generator-fast/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mazireal/site-generator-fast/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: it builds the same static sites,
byte for byte, in less CPU time. Entry for the
[make.fun bounty](https://make.fun/c/site-generator-speed-01-run-20261122)
"Build a static site faster".

## How it works

`solve.js` re-implements makefun-site's exact semantics — its front matter,
its own template dialect, its Markdown subset, its slug rule and its build
report — in a single dependency-free ES module, tuned for speed:

- one shared line split per source, feeding both front matter and Markdown;
- a single-pass Markdown renderer with chunked inline scanning and a
  fast HTML escaper (no per-character regex);
- cached slug and long-date computation;
- templates parsed once per case and rendered by a small tree walker.

`main.ts` is the driver the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).
