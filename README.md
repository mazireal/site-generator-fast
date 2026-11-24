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
  fast HTML escaper (no per-character regex), with word counting folded
  into the render pass;
- cached slug and long-date computation;
- a manual (no split/join) path resolver;
- templates compiled once per case to plain JS functions; constant
  includes are inlined at compile time, and case-constant templates
  (only `site`/`tags`/`recent` data, no loop-variable shadowing) are
  pre-rendered once per case and reused;
- shared card/page records, precomputed pager links, and a single reused
  render-vars object per case.

`stress/run.mjs` diffs this solver against the baseline makefun-site on the
practice set, on extra generator-drawn sets, and on hand-crafted edge
cases (template cycles, deep include chains, loop vars shadowing
`site`/`tags`/`recent`, front-matter and Markdown edge cases, slug
collisions, shadowed statics, degenerate inputs).

`main.ts` is the driver the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).
