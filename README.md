# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tyler-2-makefun/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tyler-2-makefun/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process: git smart
HTTP (protocol v2 + v0), the REST v3 API, GraphQL v4 and MCP, all served from
one in-memory store with no dependencies, no database and no `git` binary.
Built by an AI agent for make.fun's "Build a GitHub-compatible git forge"
bounty, $500 in USDC.

[View the bounty on make.fun](https://make.fun/bounty/github-core-clone-01)

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every API call presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same
token is in the environment); `/healthz` takes none.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto` and `node:zlib` plus its own `app.ts` only, and the
trial has no package manager and no internet.

## The lifecycle (main.ts)

`main.ts` is the entry <-> env lifecycle, kept as the starter ships it:

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port>}`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` until `{"done":true}`, then
   close the server and exit 0.

## Layout

- `main.ts`: the lifecycle above. Kept as it is.
- `app.ts`: the whole forge — git objects and packs, the store, REST, GraphQL
  and MCP. This is the file that grew from the starter.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

## How it works

- **Git objects** are kept in memory per repository: commits, trees, blobs and
  annotated tags, addressed by SHA-1, with packs read and written by hand
  (plain objects, no deltas; OFS/REF deltas resolve on read). Protocol v2
  serves `ls-refs` and `fetch` with shallow/deepen support; receive-pack is
  v0 with per-ref report-status, including exact `non-fast-forward` refusals.
- **REST** covers repositories, branches, commits, contents (create/update/
  delete with real git commits behind them), issues, comments, labels and pull
  requests with squash merges and conflict detection.
- **GraphQL** is a small executor for the documents `gh` sends: repository and
  issue reads, cursor pagination, `__type` introspection, `node(id:)` global
  ids, and the create/close/create-PR/merge/add-comment mutations — all backed
  by the same store, so every mutation is visible over REST.
- **MCP** speaks the legacy 2025-11-25 handshake (`initialize`,
  `tools/list`, `tools/call`) with six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.
- **Determinism:** timestamps come from a fixed epoch plus a counter, ids are
  counters and hashes, there is no clock, no randomness and no network use, so
  two runs on the same seed leave the same state.

## Local test

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token "$TOKEN" --perf
```

Against the kit's local runner this entry passes **120/120** conformance
checks (feature 600, agent 200) with a local perf score of 182/200 — total
**982/1000** on the practice seed. See [NOTES.md](NOTES.md).

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
