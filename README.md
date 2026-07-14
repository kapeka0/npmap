# npmap

CLI to detect which npm libraries a website uses. Give it a URL (or a list) and the **signature** of a library, and npmap temporarily downloads the HTML, bundles and JS chunks, searches for the signature, and tells you which sites ship it (see it as grep for the web).

## Requirements

- Node.js >= 20

## Install

```bash
pnpm install
pnpm build
pnpm link --global
```

## Usage

```bash
npmap <targets...> [options]
```

Targets can be positional URLs/hosts, a file (`-f targets.txt`), or stdin.

### Signatures (at least one)

- `--signature "<text>"` — literal string (repeatable)
- `--regex "<pattern>"` — regular expression (repeatable; `--ignore-case` for case-insensitive)
- `--signatures libs.json --lib <name>` — named entry from a signatures file (see `signatures.example.json`)

### Scanning

- `--follow-chunks` — follow chunks referenced inside the JS (webpack/vite)
- `--depth <n>` — chunk-follow levels (default 2)
- `--keep` — keep the temporary files

### Output

- default: readable report
- `--list` / `--quiet` — only matching hosts, one per line
- `--json` / `--ndjson` — results as JSON

Exit codes: `0` match found · `1` no match · `2` usage error.

Full flag list: `npmap --help`

## Examples

```bash
# Does it use React?
npmap https://example.com --signature "__REACT_DEVTOOLS_GLOBAL_HOOK__"

# Scan a list of subdomains and print only the ones using lodash
cat subs.txt | npmap --signatures signatures.example.json --lib lodash --follow-chunks --list
```

## Development

```bash
pnpm test   # compile and run the tests (node:test)
```

## License

MIT
