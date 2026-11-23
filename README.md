# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/chany0p/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/chany0p/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format: it reads a patch in unified diff,
SEARCH/REPLACE blocks, V4A, or JSON edits, finds the lines each edit names at the first of three
matching tiers (exact, trailing whitespace, full whitespace), and writes every change or none.
`SPEC.md` is the whole contract. Node 22 and its standard library alone, nothing installed.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-`/absent to read from standard input. Options: `--format=auto|unified|search-replace|v4a|json`,
`--check` (dry run: same output and exit code, writes nothing), `--strict` (tier 0 matching only).
Exit 0 lists the changed files (`A`/`D`/`M`/`R`) and `ok: <n> files`; exit 1 lists each failed edit and
`failed: <k> of <n> edits`; exit 2 is one line for a usage, no-patch, format or parse error.

## Files

- `main.ts`: the CLI. Sections 1–10 of SPEC.md.
- `runner.ts`: keep as is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a
  fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine:

      node check.ts <practice.json>
      node check.ts <practice.json> u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
  This entry scores **1000 on the 100 public practice checks**.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## How it works

- Detection (`auto`): `*** Begin Patch` → v4a; first non-blank line starting with `[` or `{` → json;
  a `<<<<<<< SEARCH` line → search-replace; a `diff --git` line or a `---`/`+++` pair → unified.
- Matching: old lines are found at the first tier where they occur (exact, then trailing whitespace
  ignored, then leading and trailing ignored). Unified hunks take the occurrence nearest the header's
  line number; SEARCH/REPLACE fails `ambiguous` unless the match is unique; V4A chunks follow an
  anchor and a cursor. At tier 2, new lines are re-indented from the patch's indentation to the file's.
- Atomicity: edits apply in order to the tree as earlier edits left it; a failed edit changes nothing
  and later edits still run; when any edit failed, no file is written at all.
- Line breaks: a changed file keeps its own break (LF or CRLF) and its final-break state, unless a
  unified hunk that reaches the end of the file says otherwise with a `\ No newline at end of file` line.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sd95y6wa&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
