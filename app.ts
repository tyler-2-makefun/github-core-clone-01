// forge — a standalone GitHub-compatible git forge in one process, no dependencies.
// Serves git smart HTTP (protocol v2 + v0), REST v3, GraphQL v4 and MCP from one
// in-memory store. Written for make.fun bounty github-core-clone-01.
//
// Layout: main.ts (lifecycle, kept as the starter ships it) imports createApp()
// from this file. Nothing is installed at run time: only node:http, node:crypto
// and node:zlib are used, plus the entry's own code.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z — deterministic timestamps.
const AGENT = 'forge/1.0';
const JSON_TYPE = 'application/json; charset=utf-8';

// -------------------------------------------------------------------------------------------
// small utilities
// -------------------------------------------------------------------------------------------

function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Deterministic clock: the scenario epoch plus a counter, so two runs agree. */
let tick = 0;
function nextSec(): number {
  tick += 1;
  return EPOCH_SEC + tick;
}
function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

let reqCounter = 0;
function nextRequestId(): string {
  reqCounter += 1;
  return `req-${reqCounter.toString(16).padStart(8, '0')}`;
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -------------------------------------------------------------------------------------------
// pkt-lines (git wire framing)
// -------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type PktKind = 'data' | 'flush' | 'delim';
interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. */
function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      if (off + len > buf.length) break;
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

/** Sideband packet: one band byte + payload, framed as a pkt-line. */
function sideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a buffer into sideband band-1 pkt-lines (payload <= 32 KiB each). */
function sidebandChunks(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < data.length; off += CHUNK) {
    out.push(sideband(1, data.subarray(off, Math.min(data.length, off + CHUNK))));
  }
  if (data.length === 0) out.push(sideband(1, Buffer.alloc(0)));
  return out;
}

// -------------------------------------------------------------------------------------------
// git objects
// -------------------------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: ObjType;
  data: Buffer;
}

function objectId(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([head, data]));
}

interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(tree: string, parents: readonly string[], message: string, who: string, whenSec: number): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who} ${whenSec} +0000`);
  lines.push(`committer ${who} ${whenSec} +0000`);
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Flatten a tree into path -> {oid, mode} (files only). */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

/** Build nested trees from a flat path map; returns the root tree oid. */
function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, v] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, v);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of node.files) entries.push({ mode: v.mode, name, oid: v.oid });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    const data = buildTree(entries);
    const oid = objectId('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Walk all ancestors of a commit (inclusive), newest-first by discovery order. */
function walkCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const info = parseCommit(obj.data);
    for (const p of info.parents) if (!seen.has(p)) queue.push(p);
  }
  return out;
}

/** Reachable object ids from a set of tips (commits + their trees/blobs, tags peeled).
 *  Commits in `cutoff` are included with their trees but their parents are not followed:
 *  a shallow clone holds the boundary commit, not its history. */
function reachableObjects(repo: Repo, tips: ReadonlySet<string>, cutoff?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (cutoff === undefined || !cutoff.has(oid)) {
        for (const p of info.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** Merge base: the first common ancestor of a and b (BFS from both sides). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set(walkCommits(repo, a));
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/** Is `ancestor` reachable from `tip`? */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return walkCommits(repo, tip).includes(ancestor);
}

// -------------------------------------------------------------------------------------------
// pack files
// -------------------------------------------------------------------------------------------

const PACK_TYPE: Record<number, ObjType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off]!;
      off += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (off < delta.length) {
    const op = delta[off]!;
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) {
        cpOff |= delta[off]! << (i * 8);
        off += 1;
      }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) {
        cpSize |= delta[off]! << (i * 8);
        off += 1;
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      outLen += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || outLen !== dstSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
  offset: number;
}

/** Read a pack (v2/v3), resolving OFS/REF deltas; thin-pack bases come from `resolveBase`. */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, PackEntry>();
  let off = 12;
  const pending: Array<{ offset: number; type: 'ofs-delta' | 'ref-delta'; base: string | number; data: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    let b = pack[off]!;
    off += 1;
    const typeNum = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[off]!;
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_TYPE[typeNum];
    if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === 'ofs-delta') {
      b = pack[off]!;
      off += 1;
      let base = b & 0x7f;
      while (b & 0x80) {
        b = pack[off]!;
        off += 1;
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - base;
    } else if (type === 'ref-delta') {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const data = inflateSync(pack.subarray(off));
    // Advance past the zlib stream: re-inflate a bounded slice is wasteful; instead find the
    // stream end by re-compressing length probing — simpler: use the deflate stream length via
    // a trial: inflateSync consumed exactly the zlib stream; measure with a second pass on
    // shrinking input is O(n^2). Instead, compute the consumed length with inflate of a prefix
    // using the raw stream's own length: zlib streams end with an adler32; scan for it by
    // trying inflateSync on pack.subarray(off, off + k) is too slow. Use the chunked approach:
    off = zlibStreamEnd(pack, off);
    if (type === 'ofs-delta' || type === 'ref-delta') {
      pending.push({ offset: entryOffset, type, base: type === 'ofs-delta' ? baseOffset! : baseOid!, data });
    } else {
      const oid = objectId(type, data);
      const entry: PackEntry = { type, data, offset: entryOffset };
      objects.set(oid, { type, data });
      byOffset.set(entryOffset, entry);
    }
  }
  // Resolve deltas (bases may themselves be deltas; iterate until all resolve).
  let guard = pending.length * 2 + 10;
  while (pending.length > 0 && guard-- > 0) {
    const entry = pending.shift()!;
    let baseObj: GitObject | undefined;
    if (typeof entry.base === 'number') {
      const baseEntry = byOffset.get(entry.base);
      if (baseEntry !== undefined) baseObj = { type: baseEntry.type, data: baseEntry.data };
    } else {
      baseObj = objects.get(entry.base) ?? resolveBase?.(entry.base);
    }
    if (baseObj === undefined) {
      pending.push(entry);
      continue;
    }
    const data = applyDelta(baseObj.data, entry.data);
    const oid = objectId(baseObj.type, data);
    const resolved: PackEntry = { type: baseObj.type, data, offset: entry.offset };
    objects.set(oid, { type: baseObj.type, data });
    byOffset.set(entry.offset, resolved);
  }
  if (pending.length > 0) throw new Error('unresolved delta in pack');
  return objects;
}

/** Find where the zlib stream starting at `off` ends, by binary search on inflateSync. */
function zlibStreamEnd(buf: Buffer, off: number): number {
  let lo = off + 1;
  let hi = buf.length;
  // The stream is at most the rest of the buffer; binary-search the smallest end that inflates.
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(off, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Write a pack of plain objects (no deltas) with a SHA-1 trailer. */
function writePack(entries: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const entry of entries) {
    const typeNum = TYPE_NUM[entry.type];
    let size = entry.data.length;
    const headerBytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function verifyPackTrailer(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const expected = pack.subarray(pack.length - 20);
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  return expected.equals(actual);
}

// -------------------------------------------------------------------------------------------
// store
// -------------------------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
}

interface Comment {
  id: number;
  globalId: string;
  body: string;
  seq: number;
}

interface Issue {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

interface Pull {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

class Repo {
  name: string;
  owner: string | null = null; // learned from the first owner-bearing lookup
  databaseId: number;
  privateFlag: boolean;
  description: string;
  defaultBranch = 'main';
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>(); // full ref name -> oid
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels = new Map<string, Label>();
  nextNumber = 1;
  nextCommentId = 1;
  seq = 0;

  constructor(name: string, databaseId: number, privateFlag: boolean, description: string) {
    this.name = name;
    this.databaseId = databaseId;
    this.privateFlag = privateFlag;
    this.description = description;
  }

  get globalId(): string {
    return b64url(`Repository:${this.databaseId}`);
  }

  get fullName(): string {
    return `${this.owner ?? 'unknown'}/${this.name}`;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setBranch(branch: string, oid: string): void {
    this.refs.set(`refs/heads/${branch}`, oid);
  }

  /** Flat file map of a branch tip (empty when unborn). */
  filesAt(ref: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const tip = this.branchTip(ref);
    if (tip === null) return out;
    const commit = this.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return out;
    flattenTree(this, parseCommit(commit.data).tree, '', out);
    return out;
  }

  /** Create a commit on a branch from a flat file map; returns the new commit oid. */
  commitFiles(branch: string, flat: ReadonlyMap<string, { oid: string; mode: string }>, message: string, who: string): string {
    const treeOid = buildTreeFromFlat(this, flat);
    const parent = this.branchTip(branch);
    const parents = parent === null ? [] : [parent];
    const when = nextSec();
    const data = buildCommit(treeOid, parents, message, who, when);
    const oid = objectId('commit', data);
    this.objects.set(oid, { type: 'commit', data });
    this.setBranch(branch, oid);
    return oid;
  }

  /** Sorted branch names. */
  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }
}

const store = {
  reposByName: new Map<string, Repo>(),
  nextDatabaseId: 1,
  viewerLogin: null as string | null,
};

function learnViewer(owner: string): void {
  if (store.viewerLogin === null) store.viewerLogin = owner;
}

/** Find a repo by (owner, name); learns the viewer login from the first successful hit. */
function findRepo(owner: string, name: string): Repo | null {
  const repo = store.reposByName.get(name);
  if (repo === undefined) return null;
  if (repo.owner === null) {
    repo.owner = owner;
    learnViewer(owner);
    return repo;
  }
  return repo.owner === owner ? repo : null;
}

function createRepo(name: string, privateFlag: boolean, description: string): Repo {
  const repo = new Repo(name, store.nextDatabaseId, privateFlag, description);
  store.nextDatabaseId += 1;
  store.reposByName.set(name, repo);
  return repo;
}

function repoIdentity(): string {
  // The identity server-created commits carry. No check asserts it; keep it stable.
  return 'forge <forge@example.invalid>';
}

// -------------------------------------------------------------------------------------------
// JSON shapes (REST)
// -------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.globalId,
    databaseId: repo.databaseId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner ?? store.viewerLogin ?? '', id: 1000, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    created_at: isoOf(EPOCH_SEC + repo.databaseId),
    updated_at: isoOf(EPOCH_SEC + repo.databaseId),
    url: `/api/v3/repos/${repo.fullName}`,
    html_url: `https://example.invalid/${repo.fullName}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.globalId,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    user: { login: repo.owner ?? store.viewerLogin ?? '', type: 'User' },
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.globalId,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner ?? ''}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner ?? ''}:${pull.baseRef}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    user: { login: repo.owner ?? store.viewerLogin ?? '', type: 'User' },
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const info = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const message = (info?.message ?? '').replace(/\n+$/, '');
  const authorLine = info?.author ?? '';
  const name = authorLine.includes('<') ? authorLine.slice(0, authorLine.indexOf('<')).trim() : 'forge';
  const email = authorLine.includes('<') ? authorLine.slice(authorLine.indexOf('<') + 1, authorLine.indexOf('>')) : 'forge@example.invalid';
  return {
    sha: oid,
    commit: {
      message,
      author: { name, email, date: isoOf(EPOCH_SEC) },
      committer: { name, email, date: isoOf(EPOCH_SEC) },
      tree: { sha: info?.tree ?? ZERO_OID },
    },
    parents: (info?.parents ?? []).map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.fullName}/commits/${oid}`,
  };
}

/** Line-diff counts for a pull-request file entry. */
function diffCounts(oldContent: string | null, newContent: string | null): { additions: number; deletions: number } {
  const oldLines = oldContent === null ? [] : oldContent.split('\n');
  const newLines = newContent === null ? [] : newContent.split('\n');
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const n = oldCount.get(l) ?? 0;
    if (n > 0) oldCount.set(l, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of oldCount.values()) deletions += n;
  return { additions, deletions };
}

/** Changed files of a pull request: diff merge-base tree -> head tree. */
function pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  if (base !== null) {
    const c = repo.objects.get(base);
    if (c !== undefined && c.type === 'commit') flattenTree(repo, parseCommit(c.data).tree, '', baseFlat);
  }
  const headFlat = new Map<string, { oid: string; mode: string }>();
  const hc = repo.objects.get(pull.headSha);
  if (hc !== undefined && hc.type === 'commit') flattenTree(repo, parseCommit(hc.data).tree, '', headFlat);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const oldContent = b === undefined ? null : repo.objects.get(b.oid)?.data.toString('utf8') ?? null;
    const newContent = h === undefined ? null : repo.objects.get(h.oid)?.data.toString('utf8') ?? null;
    const { additions, deletions } = diffCounts(oldContent, newContent);
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** Would squash-merging this pull conflict? (both sides changed the same file differently). */
function pullConflicts(repo: Repo, pull: Pull): boolean {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  if (base === null) return false;
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  const bc = repo.objects.get(base);
  if (bc !== undefined && bc.type === 'commit') flattenTree(repo, parseCommit(bc.data).tree, '', baseFlat);
  const headFlat = new Map<string, { oid: string; mode: string }>();
  const hc = repo.objects.get(pull.headSha);
  if (hc !== undefined && hc.type === 'commit') flattenTree(repo, parseCommit(hc.data).tree, '', headFlat);
  const tipFlat = repo.filesAt(pull.baseRef);
  for (const [path, h] of headFlat) {
    const b = baseFlat.get(path);
    if (b !== undefined && b.oid === h.oid) continue; // head did not change it
    if (b === undefined && h === undefined) continue;
    const t = tipFlat.get(path);
    const tOid = t?.oid;
    const bOid = b?.oid;
    if (tOid !== bOid && tOid !== h.oid) return true; // base changed it differently
  }
  // Files deleted on head but changed on base also conflict.
  for (const [path, b] of baseFlat) {
    if (headFlat.has(path)) continue;
    const t = tipFlat.get(path);
    if (t !== undefined && t.oid !== b.oid) return true;
  }
  return false;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid or null on conflict. */
function squashMerge(repo: Repo, pull: Pull): string | null {
  if (pullConflicts(repo, pull)) return null;
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  if (base !== null) {
    const bc = repo.objects.get(base);
    if (bc !== undefined && bc.type === 'commit') flattenTree(repo, parseCommit(bc.data).tree, '', baseFlat);
  }
  const headFlat = new Map<string, { oid: string; mode: string }>();
  const hc = repo.objects.get(pull.headSha);
  if (hc !== undefined && hc.type === 'commit') flattenTree(repo, parseCommit(hc.data).tree, '', headFlat);
  const tipFlat = repo.filesAt(pull.baseRef);
  // Apply head's changes (base -> head) onto the base tip.
  for (const [path, h] of headFlat) {
    const b = baseFlat.get(path);
    if (b === undefined || b.oid !== h.oid) tipFlat.set(path, h);
  }
  for (const path of baseFlat.keys()) {
    if (!headFlat.has(path)) tipFlat.delete(path);
  }
  const treeOid = buildTreeFromFlat(repo, tipFlat);
  const parent = repo.branchTip(pull.baseRef);
  const parents = parent === null ? [] : [parent];
  const when = nextSec();
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const data = buildCommit(treeOid, parents, message, repoIdentity(), when);
  const oid = objectId('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.setBranch(pull.baseRef, oid);
  return oid;
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function errJson(res: ServerResponse, status: number, message: string, extra: Readonly<Record<string, string>> = {}): void {
  sendJson(res, status, { message }, extra);
}

function urlOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { path: u.pathname, query: u.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(h.trim());
  return m ? m[1]! : null;
}

function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** The one token the suite presents; empty locally means "accept any non-empty token". */
function authed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  const expected = shopToken();
  if (expected === '') return true;
  return token === expected;
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strField(v: unknown, key: string): string | null {
  if (!isRecord(v)) return null;
  const x = v[key];
  return typeof x === 'string' ? x : null;
}

function intQuery(q: URLSearchParams, key: string, fallback: number): number {
  const raw = q.get(key);
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse a ref-update command list (pkt-lines) from a receive-pack body. */
function parseReceiveCommands(body: Buffer): { commands: Array<{ oldOid: string; newOid: string; ref: string }>; packStart: number } | null {
  let off = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  while (off + 4 <= body.length) {
    const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
    if (!Number.isFinite(len)) return null;
    if (len === 0) {
      off += 4;
      break;
    }
    if (len < 4 || off + len > body.length) return null;
    const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
    off += len;
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const parts = head.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2]!.startsWith('refs/')) return null;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) return null;
  return { commands, packStart: off };
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

type GitService = 'git-upload-pack' | 'git-receive-pack';

function sortedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      out.push({ name, oid, peeled: parseTag(obj.data).object });
    } else {
      out.push({ name, oid });
    }
  }
  return out;
}

function v0Advertise(repo: Repo, service: GitService): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status report-status-v2 side-band-64k delete-refs symref=HEAD:refs/heads/main object-format=sha1 agent=forge/1.0'
      : 'symref=HEAD:refs/heads/main object-format=sha1 side-band-64k shallow thin-pack ofs-delta agent=forge/1.0';
  const parts: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const tip = repo.branchTip(repo.defaultBranch);
  if (refs.length === 0) {
    parts.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    parts.push(`${tip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const r of refs) {
      parts.push(`${r.oid} ${r.name}\n`);
      if (r.peeled !== undefined) parts.push(`${r.peeled} ${r.name}^{}\n`);
    }
  }
  parts.push('flush');
  return pktLines(parts);
}

function v2Advertise(): Buffer {
  return pktLines(['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n', 'flush']);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: GitService): void {
  const repo = findRepo(owner, repoName);
  if (repo === null) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const v2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = v2 ? v2Advertise() : v0Advertise(repo, service);
  sendRaw(res, 200, body, `application/x-${service}-advertisement`);
}

/** Ref lines for ls-refs, honouring peel/symrefs/unborn/ref-prefix. */
function lsRefsLines(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): string[] {
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const tip = repo.branchTip(repo.defaultBranch);
  const entries: Array<{ oid: string; name: string; peeled?: string; symrefTarget?: string; isUnborn?: boolean }> = [];
  if (refs.length === 0) {
    if (opts.unborn) entries.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, isUnborn: true });
  } else {
    entries.push({ oid: tip ?? ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
    for (const r of refs) entries.push({ oid: r.oid, name: r.name, peeled: r.peeled });
  }
  for (const e of entries) {
    if (opts.prefixes.length > 0 && !opts.prefixes.some((p) => e.name.startsWith(p))) continue;
    if (e.isUnborn === true) {
      lines.push(`unborn ${e.name}${opts.symrefs && e.symrefTarget ? ` symref-target:${e.symrefTarget}` : ''}\n`);
      continue;
    }
    let line = `${e.oid} ${e.name}`;
    if (opts.symrefs && e.symrefTarget) line += ` symref-target:${e.symrefTarget}`;
    if (opts.peel && e.peeled) line += ` peeled:${e.peeled}`;
    lines.push(`${line}\n`);
  }
  return lines;
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Objects to send for a fetch, plus shallow-info lines. */
function planFetch(repo: Repo, plan: FetchPlan): { objects: GitObject[]; shallowLines: string[]; acks: string[]; nak: boolean } {
  const wantSet = new Set(plan.wants);
  // Peel tag wants to their commits for traversal, but keep the tag objects themselves.
  const commitTips = new Set<string>();
  for (const w of wantSet) {
    const obj = repo.objects.get(w);
    if (obj === undefined) continue;
    if (obj.type === 'tag') commitTips.add(parseTag(obj.data).object);
    else if (obj.type === 'commit') commitTips.add(w);
  }
  // Commit set: BFS from tips, honouring depth (depth counts commits from the wants).
  const includedCommits = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: string[] = [...commitTips];
  for (const t of queue) depthOf.set(t, 1);
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const d = depthOf.get(oid)!;
    if (plan.depth !== null && d > plan.depth) continue;
    if (includedCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    includedCommits.add(oid);
    if (plan.depth !== null && d >= plan.depth) continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!depthOf.has(p)) {
        depthOf.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  // Closure of the included commits (trees/blobs) plus wanted tag objects.
  const send = new Set<string>();
  for (const c of includedCommits) {
    const cObj = repo.objects.get(c);
    if (cObj === undefined) continue;
    send.add(c);
    const info = parseCommit(cObj.data);
    const stack = [info.tree];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (send.has(t)) continue;
      send.add(t);
      const tObj = repo.objects.get(t);
      if (tObj !== undefined && tObj.type === 'tree') for (const e of parseTree(tObj.data)) stack.push(e.oid);
    }
  }
  for (const w of wantSet) {
    const obj = repo.objects.get(w);
    if (obj !== undefined && obj.type === 'tag') send.add(w);
  }
  // Minus everything reachable from the haves — but never past a shallow boundary:
  // the client holds the boundary commit, not its parents.
  const haveReachable = reachableObjects(repo, new Set(plan.haves), new Set(plan.shallow));
  for (const oid of haveReachable) send.delete(oid);
  // But the wanted tips themselves must be sent even if reachable from a have? No: if a want
  // is reachable from a have, the client already has it — excluding it is correct.
  const objects: GitObject[] = [];
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  // Shallow-info lines.
  const shallowLines: string[] = [];
  if (plan.depth !== null) {
    for (const c of includedCommits) {
      if (!send.has(c)) continue;
      const d = depthOf.get(c)!;
      if (d !== plan.depth) continue;
      const obj = repo.objects.get(c);
      if (obj === undefined) continue;
      const parents = parseCommit(obj.data).parents;
      const hasUnsentParent = parents.some((p) => !includedCommits.has(p) || !send.has(p));
      const isRoot = parents.length === 0;
      if (hasUnsentParent || isRoot) shallowLines.push(`shallow ${c}\n`);
    }
  }
  for (const b of plan.shallow) {
    if (!send.has(b)) continue;
    const obj = repo.objects.get(b);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => send.has(p)) || parents.length === 0) shallowLines.push(`unshallow ${b}\n`);
  }
  // ACKs: every have reachable from a want. With no haves there is nothing to ack,
  // and skipping the full-history traversal keeps shallow clones fast.
  const acks: string[] = [];
  if (plan.haves.length > 0) {
    const wantReachable = reachableObjects(repo, new Set([...commitTips, ...[...wantSet].filter((w) => repo.objects.get(w)?.type === 'tag')]));
    for (const h of plan.haves) if (wantReachable.has(h)) acks.push(h);
  }
  return { objects, shallowLines, acks, nak: acks.length === 0 };
}

function handleUploadPackV2(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const pkts = decodePkts(body);
  const lines: string[] = [];
  let delimSeen = false;
  for (const p of pkts) {
    if (p.kind === 'delim') {
      delimSeen = true;
      continue;
    }
    if (p.kind === 'flush') break;
    lines.push(p.payload.toString('utf8'));
  }
  if (lines.length === 0) {
    errJson(res, 400, 'empty upload-pack request');
    return;
  }
  const command = (lines[0] ?? '').replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      const t = line.replace(/\n$/, '');
      if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
      else if (t === 'unborn') unborn = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
    }
    void delimSeen;
    const out = lsRefsLines(repo, { peel, symrefs, unborn, prefixes });
    sendRaw(res, 200, pktLines([...out, 'flush']), 'application/x-git-upload-pack-result');
    return;
  }
  if (command !== 'command=fetch') {
    errJson(res, 400, `unknown upload-pack command ${JSON.stringify(command)}`);
    return;
  }
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines.slice(1)) {
    const t = line.replace(/\n$/, '');
    if (t.startsWith('want ')) plan.wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) plan.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) plan.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) {
      const n = parseInt(t.slice(7).trim(), 10);
      if (Number.isFinite(n)) plan.depth = n;
    }
  }
  const { objects, shallowLines, acks, nak } = planFetch(repo, plan);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (nak) parts.push(pktLine('NAK\n'));
  else for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
  parts.push(PKT_FLUSH);
  parts.push(pktLine('shallow-info\n'));
  for (const l of shallowLines) parts.push(pktLine(l));
  parts.push(PKT_FLUSH);
  parts.push(pktLine('packfile\n'));
  for (const c of sidebandChunks(pack)) parts.push(c);
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const pkts = decodePkts(body);
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const p of pkts) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const t = p.payload.toString('utf8').replace(/\n$/, '');
    if (t.startsWith('want ')) {
      const rest = t.slice(5).trim();
      plan.wants.push(rest.split(' ')[0]!);
    } else if (t.startsWith('have ')) plan.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) plan.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) {
      const n = parseInt(t.slice(7).trim(), 10);
      if (Number.isFinite(n)) plan.depth = n;
    }
  }
  void section;
  const { objects, shallowLines, acks, nak } = planFetch(repo, plan);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (nak) parts.push(pktLine('NAK\n'));
  else for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
  for (const l of shallowLines) parts.push(pktLine(l));
  for (const c of sidebandChunks(pack)) parts.push(c);
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const parsed = parseReceiveCommands(body);
  if (parsed === null) {
    // Malformed command list: report an unpack error but stay up.
    const report = pktLines(['unpack error\n', 'flush']);
    const out = Buffer.concat([...sidebandChunks(report), PKT_FLUSH]);
    sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
    return;
  }
  const { commands, packStart } = parsed;
  // Unpack first: store every object, even for refused refs.
  let unpackOk = true;
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      if (!verifyPackTrailer(packBytes)) throw new Error('pack trailer mismatch');
      const incoming = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of incoming) repo.objects.set(oid, obj);
    } catch {
      unpackOk = false;
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? null;
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === null) reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        else if (current !== cmd.oldOid) reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        else {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== null) {
          reportLines.push(`ng ${cmd.ref} already exists\n`);
          continue;
        }
        if (!repo.objects.has(cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} missing object\n`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      // Update.
      if (current === null) {
        reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        continue;
      }
      if (current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} missing object\n`);
        continue;
      }
      if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
  } else {
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed\n`);
  }
  const report = pktLines([...reportLines, 'flush']);
  const out = Buffer.concat([...sidebandChunks(report), PKT_FLUSH]);
  sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

function pageSlice<T>(items: readonly T[], q: URLSearchParams): { page: T[]; link: string | null; totalPages: number } {
  const perPage = Math.min(100, intQuery(q, 'per_page', 30));
  const page = intQuery(q, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: null, totalPages };
}

function linkHeader(req: IncomingMessage, basePath: string, q: URLSearchParams, page: number, totalPages: number, perPage: number): string | null {
  const host = req.headers.host ?? '127.0.0.1';
  const origin = `http://${host}`;
  const mk = (p: number): string => `${origin}${basePath}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${mk(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${mk(page - 1)}>; rel="prev"`);
  parts.push(`<${mk(1)}>; rel="first"`);
  parts.push(`<${mk(totalPages)}>; rel="last"`);
  return parts.length > 0 ? parts.join(', ') : null;
}

function pagedJson<T>(req: IncomingMessage, res: ServerResponse, items: readonly T[], path: string, q: URLSearchParams, toJson: (t: T) => unknown): void {
  const perPage = Math.min(100, intQuery(q, 'per_page', 30));
  const page = intQuery(q, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const extra: Record<string, string> = {};
  const link = linkHeader(req, path, q, page, totalPages, perPage);
  if (link !== null) extra.link = link;
  sendJson(res, 200, slice.map(toJson), extra);
}

function handleUserRepos(req: IncomingMessage, res: ServerResponse, method: string, body: Buffer): void {
  if (method === 'POST') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      errJson(res, 400, 'Invalid JSON');
      return;
    }
    const name = strField(parsed.value, 'name');
    if (name === null || name === '') {
      errJson(res, 422, 'name is required');
      return;
    }
    if (store.reposByName.has(name)) {
      errJson(res, 422, `Repository ${name} already exists`);
      return;
    }
    const privateFlag = isRecord(parsed.value) && parsed.value.private === true;
    const description = strField(parsed.value, 'description') ?? '';
    const repo = createRepo(name, privateFlag, description);
    sendJson(res, 201, repoJson(repo));
    return;
  }
  if (method === 'GET') {
    const { query } = urlOf(req);
    const repos = [...store.reposByName.values()];
    pagedJson(req, res, repos, '/api/v3/user/repos', query, (r) => repoJson(r));
    return;
  }
  errJson(res, 404, 'Not Found');
}

function handleRepos(req: IncomingMessage, res: ServerResponse, owner: string, name: string, rest: string[], method: string, body: Buffer): void {
  const repo = findRepo(owner, name);
  if (repo === null) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const { query } = urlOf(req);
  const sub = rest[0] ?? '';

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        errJson(res, 400, 'Invalid JSON');
        return;
      }
      if (isRecord(parsed.value)) {
        const d = strField(parsed.value, 'description');
        if (d !== null) repo.description = d;
        if (typeof parsed.value.private === 'boolean') repo.privateFlag = parsed.value.private;
      }
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.reposByName.delete(name);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // /branches
  if (sub === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = repo.branchNames().map((b) => ({ name: b, commit: { sha: repo.branchTip(b) ?? '' } }));
      sendJson(res, 200, list);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = rest[1]!;
      const tip = repo.branchTip(branch);
      if (tip === null) {
        errJson(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip } });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // /commits
  if (sub === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = query.get('sha');
      let tip: string | null = null;
      if (shaParam !== null && shaParam !== '') {
        tip = repo.branchTip(shaParam) ?? (repo.objects.has(shaParam) ? shaParam : null);
      } else {
        tip = repo.branchTip(repo.defaultBranch);
      }
      if (tip === null) {
        errJson(res, 404, 'Not Found');
        return;
      }
      const commits = walkCommits(repo, tip);
      pagedJson(req, res, commits, `/api/v3/repos/${owner}/${name}/commits`, query, (oid) => commitJson(repo, oid));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // /contents/*
  if (sub === 'contents') {
    handleContents(req, res, repo, rest.slice(1).join('/'), method, body);
    return;
  }

  // /issues
  if (sub === 'issues') {
    handleIssues(req, res, repo, owner, name, rest.slice(1), method, body);
    return;
  }

  // /labels
  if (sub === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        errJson(res, 400, 'Invalid JSON');
        return;
      }
      const labelName = strField(parsed.value, 'name');
      if (labelName === null || labelName === '') {
        errJson(res, 422, 'name is required');
        return;
      }
      const color = strField(parsed.value, 'color') ?? 'ededed';
      repo.labels.set(labelName, { name: labelName, color });
      sendJson(res, 201, { name: labelName, color });
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()]);
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // /pulls
  if (sub === 'pulls') {
    handlePulls(req, res, repo, owner, name, rest.slice(1), method, body);
    return;
  }

  // /git/refs
  if (sub === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        errJson(res, 400, 'Invalid JSON');
        return;
      }
      const ref = strField(parsed.value, 'ref');
      const sha = strField(parsed.value, 'sha');
      if (ref === null || sha === null || !ref.startsWith('refs/')) {
        errJson(res, 422, 'ref and sha are required');
        return;
      }
      if (repo.refs.has(ref)) {
        errJson(res, 422, 'Reference already exists');
        return;
      }
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') {
        errJson(res, 422, 'Invalid sha');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha }, sha });
      return;
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const branch = rest[3]!;
      const tip = repo.branchTip(branch);
      if (tip === null) {
        errJson(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip }, sha: tip });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  errJson(res, 404, 'Not Found');
}

function dirTreeOid(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>, dir: string): string {
  const sub = new Map<string, { oid: string; mode: string }>();
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const [path, v] of flat) {
    if (prefix === '' || path.startsWith(prefix)) sub.set(path.slice(prefix.length), v);
  }
  return buildTreeFromFlat(repo, sub);
}

function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, path: string, method: string, body: Buffer): void {
  const { query } = urlOf(req);
  const decodedPath = path; // already decoded segment-by-segment by the router
  const ref = query.get('ref') ?? repo.defaultBranch;

  if (method === 'GET') {
    const flat = repo.filesAt(ref);
    const file = flat.get(decodedPath);
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: decodedPath.split('/').pop() ?? '',
        path: decodedPath,
        content: data.toString('base64'),
        sha: file.oid,
      });
      return;
    }
    // Directory listing (or root when path is empty).
    const prefix = decodedPath === '' ? '' : `${decodedPath}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [p, v] of flat) {
      if (prefix !== '' && !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const seg = rest.split('/')[0]!;
      const childPath = prefix + seg;
      if (rest.includes('/')) {
        if (!children.has(childPath)) {
          children.set(childPath, { type: 'dir', name: seg, path: childPath, sha: dirTreeOid(repo, flat, childPath) });
        }
      } else {
        children.set(childPath, { type: 'file', name: seg, path: childPath, sha: v.oid });
      }
    }
    if (decodedPath !== '' && children.size === 0) {
      errJson(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
    return;
  }

  if (method === 'PUT') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      errJson(res, 400, 'Invalid JSON');
      return;
    }
    const message = strField(parsed.value, 'message') ?? 'update';
    const contentB64 = strField(parsed.value, 'content');
    if (contentB64 === null) {
      errJson(res, 422, 'content is required');
      return;
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      errJson(res, 422, 'content is not valid base64');
      return;
    }
    const branch = strField(parsed.value, 'branch') ?? repo.defaultBranch;
    // A named branch that does not exist yet forks from the default branch tip.
    if (repo.branchTip(branch) === null) {
      const defaultTip = repo.branchTip(repo.defaultBranch);
      if (defaultTip !== null) repo.setBranch(branch, defaultTip);
    }
    const flat = repo.filesAt(branch);
    const existing = flat.get(decodedPath);
    const sha = strField(parsed.value, 'sha');
    if (existing !== undefined) {
      if (sha === null) {
        errJson(res, 422, 'sha wasn\'t supplied');
        return;
      }
      if (sha !== existing.oid) {
        errJson(res, 409, 'sha does not match the latest version');
        return;
      }
    }
    const blobOid = objectId('blob', content);
    repo.objects.set(blobOid, { type: 'blob', data: content });
    flat.set(decodedPath, { oid: blobOid, mode: '100644' });
    const commitOid = repo.commitFiles(branch, flat, message, repoIdentity());
    sendJson(res, existing !== undefined ? 200 : 201, {
      content: { name: decodedPath.split('/').pop() ?? '', path: decodedPath, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      errJson(res, 400, 'Invalid JSON');
      return;
    }
    const message = strField(parsed.value, 'message') ?? 'delete';
    const sha = strField(parsed.value, 'sha');
    const branch = strField(parsed.value, 'branch') ?? repo.defaultBranch;
    const flat = repo.filesAt(branch);
    const existing = flat.get(decodedPath);
    if (existing === undefined) {
      errJson(res, 404, 'Not Found');
      return;
    }
    if (sha !== null && sha !== existing.oid) {
      errJson(res, 409, 'sha does not match the latest version');
      return;
    }
    flat.delete(decodedPath);
    const commitOid = repo.commitFiles(branch, flat, message, repoIdentity());
    sendJson(res, 200, { commit: { sha: commitOid, message } });
    return;
  }

  errJson(res, 404, 'Not Found');
}

function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, owner: string, name: string, rest: string[], method: string, body: Buffer): void {
  const { query } = urlOf(req);
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      pagedJson(req, res, list, `/api/v3/repos/${owner}/${name}/issues`, query, (i) => issueJson(repo, i));
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        errJson(res, 400, 'Invalid JSON');
        return;
      }
      const title = strField(parsed.value, 'title');
      if (title === null || title === '') {
        errJson(res, 422, 'title is required');
        return;
      }
      const bodyText = strField(parsed.value, 'body') ?? '';
      const labels = isRecord(parsed.value) && Array.isArray(parsed.value.labels)
        ? parsed.value.labels.filter((l): l is string => typeof l === 'string')
        : [];
      for (const l of labels) {
        if (!repo.labels.has(l)) {
          errJson(res, 422, `label ${l} does not exist`);
          return;
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      repo.seq += 1;
      const when = isoOf(nextSec());
      const issue: Issue = {
        number,
        globalId: b64url(`Issue:${repo.databaseId}:${number}`),
        title,
        body: bodyText,
        state: 'open',
        labels,
        comments: [],
        seq: repo.seq,
        createdAt: when,
        updatedAt: when,
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  const number = parseInt(rest[0]!, 10);
  const issue = repo.issues.find((i) => i.number === number);
  if (issue === undefined) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        errJson(res, 400, 'Invalid JSON');
        return;
      }
      if (isRecord(parsed.value)) {
        const state = strField(parsed.value, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = strField(parsed.value, 'title');
        if (title !== null) issue.title = title;
        const b = strField(parsed.value, 'body');
        if (b !== null) issue.body = b;
      }
      issue.updatedAt = isoOf(nextSec());
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  if (rest[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: c.globalId, body: c.body })));
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        errJson(res, 400, 'Invalid JSON');
        return;
      }
      const text = strField(parsed.value, 'body');
      if (text === null) {
        errJson(res, 422, 'body is required');
        return;
      }
      const id = repo.nextCommentId;
      repo.nextCommentId += 1;
      repo.seq += 1;
      const comment: Comment = { id, globalId: b64url(`IssueComment:${repo.databaseId}:${number}:${id}`), body: text, seq: repo.seq };
      issue.comments.push(comment);
      issue.updatedAt = isoOf(nextSec());
      sendJson(res, 201, { id: comment.id, node_id: comment.globalId, body: comment.body });
      return;
    }
  }
  errJson(res, 404, 'Not Found');
}

function handlePulls(req: IncomingMessage, res: ServerResponse, repo: Repo, owner: string, name: string, rest: string[], method: string, body: Buffer): void {
  const { query } = urlOf(req);
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      pagedJson(req, res, list, `/api/v3/repos/${owner}/${name}/pulls`, query, (p) => pullJson(repo, p));
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        errJson(res, 400, 'Invalid JSON');
        return;
      }
      const title = strField(parsed.value, 'title');
      const head = strField(parsed.value, 'head');
      const base = strField(parsed.value, 'base');
      if (title === null || head === null || base === null) {
        errJson(res, 422, 'title, head and base are required');
        return;
      }
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (headSha === null || baseSha === null) {
        errJson(res, 422, 'head or base branch does not exist');
        return;
      }
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (dup !== undefined) {
        errJson(res, 422, 'a pull request already exists for this head and base');
        return;
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      repo.seq += 1;
      const when = isoOf(nextSec());
      const pull: Pull = {
        number,
        globalId: b64url(`PullRequest:${repo.databaseId}:${number}`),
        title,
        body: strField(parsed.value, 'body') ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        seq: repo.seq,
        createdAt: when,
        updatedAt: when,
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  const number = parseInt(rest[0]!, 10);
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  if (rest[1] === 'files' && method === 'GET') {
    sendJson(res, 200, pullFiles(repo, pull));
    return;
  }
  if (rest[1] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open') {
      errJson(res, 405, 'pull request is already closed');
      return;
    }
    const mergeSha = squashMerge(repo, pull);
    if (mergeSha === null) {
      errJson(res, 405, 'merge conflict');
      return;
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOf(nextSec());
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = isoOf(nextSec());
    sendJson(res, 200, { merged: true, sha: mergeSha, message: `Pull request #${pull.number} merged` });
    return;
  }
  errJson(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// GraphQL v4 (a small executor for the documents gh / github-mcp-server send)
// -------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selection: GqlField[] | null;
  fragmentType: string | null;
}

interface GqlDocument {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: GqlField[];
}

class GqlParseError extends Error {}
class GqlFieldError extends Error {}

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j]!;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new GqlParseError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    if (t === undefined) throw new GqlParseError('unexpected end of document');
    return t;
  }
  private expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new GqlParseError(`expected ${t}, got ${got}`);
  }

  parseDocument(): GqlDocument {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      operation = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{') {
        name = this.next();
      }
    }
    // Variable definitions: ($x: Type, ...) — skip, we only need the names at use sites.
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const t = this.next();
        if (t === '(' || t === '[') depth += 1;
        else if (t === ')' || t === ']') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    const selection = this.parseSelectionSet();
    return { operation, name, selection };
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new GqlParseError('unterminated selection set');
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      }
      const selection = this.parseSelectionSet();
      return { alias: null, name: '', args: {}, selection, fragmentType };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.next();
    }
    let selection: GqlField[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection, fragmentType: null };
  }

  private parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const fname = this.next();
        this.expect(':');
        fields.push({ name: fname, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (t === 'true') return { kind: 'boolean', value: true };
    if (t === 'false') return { kind: 'boolean', value: false };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: parseInt(t, 10) };
    if (/^-?\d*\.\d+$/.test(t)) return { kind: 'float', value: parseFloat(t) };
    return { kind: 'enum', value: t };
  }
}

function resolveGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return vars[v.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return v.value;
    case 'null':
      return null;
    case 'list':
      return v.items.map((i) => resolveGqlValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveGqlValue(f.value, vars);
      return out;
    }
  }
}

// --- schema knowledge (field allowlists, for validation + introspection) ---

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'private', 'url', 'createdAt', 'updatedAt', 'issues', 'issue', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'totalCount'],
  PullRequestFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
  RepositoryOwner: ['login', 'id'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const TYPE_KIND: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  SearchType: 'ENUM',
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

interface GqlNode {
  __type: string;
  value: unknown;
}

function gqlStateOfIssue(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function gqlStateOfPull(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepoByDbId(dbId: number): Repo | null {
  for (const r of store.reposByName.values()) if (r.databaseId === dbId) return r;
  return null;
}

function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    const type = parts[0];
    if (type === undefined || parts.length < 2) return null;
    return { type, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function resolveGlobalId(id: string): GqlNode | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10));
    return repo === null ? null : { __type: 'Repository', value: repo };
  }
  if (decoded.type === 'Issue') {
    const repo = findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10));
    const issue = repo?.issues.find((i) => i.number === parseInt(decoded.parts[1] ?? '', 10));
    return issue === undefined || repo === undefined ? null : { __type: 'Issue', value: { repo, issue } };
  }
  if (decoded.type === 'PullRequest') {
    const repo = findRepoByDbId(parseInt(decoded.parts[0] ?? '', 10));
    const pull = repo?.pulls.find((p) => p.number === parseInt(decoded.parts[1] ?? '', 10));
    return pull === undefined || repo === undefined ? null : { __type: 'PullRequest', value: { repo, pull } };
  }
  return null;
}

function makeIssueInRepo(repo: Repo, title: string, body: string): Issue {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  repo.seq += 1;
  const when = isoOf(nextSec());
  const issue: Issue = {
    number,
    globalId: b64url(`Issue:${repo.databaseId}:${number}`),
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: repo.seq,
    createdAt: when,
    updatedAt: when,
  };
  repo.issues.push(issue);
  return issue;
}

function makePullInRepo(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headSha = repo.branchTip(head);
  const baseSha = repo.branchTip(base);
  if (headSha === null || baseSha === null) return null;
  const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (dup !== undefined) return null;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  repo.seq += 1;
  const when = isoOf(nextSec());
  const pull: Pull = {
    number,
    globalId: b64url(`PullRequest:${repo.databaseId}:${number}`),
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq: repo.seq,
    createdAt: when,
    updatedAt: when,
  };
  repo.pulls.push(pull);
  return pull;
}

/** Cursor over an ordered list: position-based, opaque. */
function encodeCursor(pos: number): string {
  return b64url(`cursor:${pos}`);
}
function decodeCursor(c: string): number | null {
  try {
    const text = Buffer.from(c, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1]!, 10) : null;
  } catch {
    return null;
  }
}

interface ConnectionResult {
  nodes: GqlNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null };
  totalCount: number;
}

function paginateNodes(nodes: GqlNode[], first: number | null, after: string | null): ConnectionResult {
  let start = 0;
  if (after !== null && after !== '') {
    const pos = decodeCursor(after);
    if (pos !== null) start = pos + 1;
  }
  const end = first === null ? nodes.length : Math.min(nodes.length, start + first);
  const page = nodes.slice(start, end);
  return {
    nodes: page,
    pageInfo: {
      hasNextPage: end < nodes.length,
      endCursor: page.length > 0 ? encodeCursor(start + page.length - 1) : null,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(start) : null,
    },
    totalCount: nodes.length,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): ConnectionResult {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((i) => wanted.has(gqlStateOfIssue(i)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 'asc' : 'desc';
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const nodes = list.map((issue) => ({ __type: 'Issue', value: { repo, issue } }) as GqlNode);
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? args.after : null;
  return paginateNodes(nodes, first, after);
}

function pullConnection(repo: Repo, args: Record<string, unknown>): ConnectionResult {
  let list = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((p) => wanted.has(gqlStateOfPull(p)));
  } else {
    list = list.filter((p) => p.state === 'open');
  }
  list.sort((a, b) => b.seq - a.seq);
  const nodes = list.map((pull) => ({ __type: 'PullRequest', value: { repo, pull } }) as GqlNode);
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? args.after : null;
  return paginateNodes(nodes, first, after);
}

/** Resolve one field of a node; returns a raw value or a GqlNode / connection object. */
function resolveField(node: GqlNode, field: string, args: Record<string, unknown>): unknown {
  const type = node.__type;
  const allowed = TYPE_FIELDS[type];
  if (allowed !== undefined && !allowed.includes(field)) {
    throw new GqlFieldError(`Cannot query field "${field}" on type "${type}".`);
  }
  const v = node.value;
  switch (type) {
    case 'Query': {
      if (field === 'viewer') {
        return { __type: 'User', value: { login: store.viewerLogin ?? '' } } as GqlNode;
      }
      if (field === 'repository') {
        const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : ({ __type: 'Repository', value: repo } as GqlNode);
      }
      if (field === 'node') {
        return resolveGlobalId(String(args.id ?? ''));
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        const kind = TYPE_KIND[name];
        if (kind === undefined) return null;
        return { __type: '__Type', value: { name, kind } } as GqlNode;
      }
      break;
    }
    case 'User': {
      const u = v as { login: string };
      if (field === 'login') return u.login;
      if (field === 'id') return b64url(`User:${u.login}`);
      if (field === 'name') return u.login;
      break;
    }
    case 'Repository': {
      const repo = v as Repo;
      if (field === 'id') return repo.globalId;
      if (field === 'databaseId') return repo.databaseId;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return repo.fullName;
      if (field === 'owner') return { __type: 'RepositoryOwner', value: { login: repo.owner ?? store.viewerLogin ?? '' } } as GqlNode;
      if (field === 'defaultBranchRef') return { __type: 'Ref', value: { name: repo.defaultBranch } } as GqlNode;
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'isPrivate' || field === 'private') return repo.privateFlag;
      if (field === 'url') return `https://example.invalid/${repo.fullName}`;
      if (field === 'createdAt' || field === 'updatedAt') return isoOf(EPOCH_SEC + repo.databaseId);
      if (field === 'issues') return { __type: 'IssueConnection', value: issueConnection(repo, args) } as GqlNode;
      if (field === 'issue') {
        const issue = repo.issues.find((i) => i.number === args.number);
        return issue === undefined ? null : ({ __type: 'Issue', value: { repo, issue } } as GqlNode);
      }
      if (field === 'pullRequests') return { __type: 'PullRequestConnection', value: pullConnection(repo, args) } as GqlNode;
      if (field === 'pullRequest') {
        const pull = repo.pulls.find((p) => p.number === args.number);
        return pull === undefined ? null : ({ __type: 'PullRequest', value: { repo, pull } } as GqlNode);
      }
      break;
    }
    case 'Issue': {
      const { issue } = v as { repo: Repo; issue: Issue };
      if (field === 'id') return issue.globalId;
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'body') return issue.body;
      if (field === 'state') return gqlStateOfIssue(issue);
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'url') return `https://example.invalid/issues/${issue.number}`;
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = v as { repo: Repo; pull: Pull };
      if (field === 'id') return pull.globalId;
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return gqlStateOfPull(pull);
      if (field === 'merged') return pull.merged;
      if (field === 'mergedAt') return pull.mergedAt;
      if (field === 'mergeable') return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'headRefOid') return pull.headSha;
      if (field === 'baseRefOid') return pull.baseSha;
      if (field === 'createdAt') return pull.createdAt;
      if (field === 'updatedAt') return pull.updatedAt;
      if (field === 'url') return `https://example.invalid/pulls/${pull.number}`;
      if (field === 'files') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = pullFiles(repo, pull).slice(0, first).map((f) => ({ __type: 'PullRequestFile', value: { path: f.filename } }) as GqlNode);
        return { __type: 'PullRequestFileConnection', value: { nodes: files, totalCount: files.length } } as GqlNode;
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const conn = v as ConnectionResult;
      if (field === 'nodes') return conn.nodes;
      if (field === 'pageInfo') return { __type: 'PageInfo', value: conn.pageInfo } as GqlNode;
      if (field === 'totalCount') return conn.totalCount;
      break;
    }
    case 'PullRequestFileConnection': {
      const conn = v as { nodes: GqlNode[]; totalCount: number };
      if (field === 'nodes') return conn.nodes;
      if (field === 'totalCount') return conn.totalCount;
      break;
    }
    case 'PullRequestFile': {
      if (field === 'path') return (v as { path: string }).path;
      break;
    }
    case 'PageInfo': {
      const p = v as ConnectionResult['pageInfo'];
      if (field === 'hasNextPage') return p.hasNextPage;
      if (field === 'endCursor') return p.endCursor;
      if (field === 'hasPreviousPage') return p.hasPreviousPage;
      if (field === 'startCursor') return p.startCursor;
      break;
    }
    case 'Ref': {
      if (field === 'name') return (v as { name: string }).name;
      break;
    }
    case 'RepositoryOwner': {
      const o = v as { login: string };
      if (field === 'login') return o.login;
      if (field === 'id') return b64url(`User:${o.login}`);
      break;
    }
    case '__Type': {
      const t = v as { name: string; kind: string };
      if (field === 'name') return t.name;
      if (field === 'kind') return t.kind;
      if (field === 'fields') {
        if (t.kind !== 'OBJECT') return null;
        return (TYPE_FIELDS[t.name] ?? []).map((n) => ({ __type: '__Field', value: { name: n } }) as GqlNode);
      }
      if (field === 'enumValues') {
        if (t.kind !== 'ENUM') return null;
        return SEARCH_TYPE_VALUES.map((n) => ({ __type: '__EnumValue', value: { name: n } }) as GqlNode);
      }
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (field === 'name') return (v as { name: string }).name;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload': {
      const slot = PAYLOAD_FIELDS[type]?.[field];
      if (slot === undefined) throw new GqlFieldError(`Cannot query field "${field}" on type "${type}".`);
      return (v as Record<string, unknown>)[slot] ?? null;
    }
    case 'IssueCommentEdge': {
      if (field === 'node') return (v as { node: GqlNode }).node;
      break;
    }
    case 'IssueComment': {
      const c = v as Comment;
      if (field === 'id') return c.globalId;
      if (field === 'body') return c.body;
      break;
    }
  }
  throw new GqlFieldError(`Cannot query field "${field}" on type "${type}".`);
}

/** Execute a selection set against a node, honouring aliases and inline fragments. */
function executeSelection(node: GqlNode, fields: GqlField[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragmentType !== null) {
      if (f.fragmentType === node.__type && f.selection !== null) {
        Object.assign(out, executeSelection(node, f.selection, vars));
      }
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(f.args)) args[k] = resolveGqlValue(val, vars);
    const raw = resolveField(node, f.name, args);
    const key = f.alias ?? f.name;
    out[key] = projectValue(raw, f.selection, vars);
  }
  return out;
}

function projectValue(raw: unknown, selection: GqlField[] | null, vars: Record<string, unknown>): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => projectValue(item, selection, vars));
  if (typeof raw === 'object' && '__type' in (raw as Record<string, unknown>)) {
    const node = raw as GqlNode;
    if (selection === null) return {};
    return executeSelection(node, selection, vars);
  }
  return raw;
}

/** Run the root mutation fields. */
function executeMutation(doc: GqlDocument, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of doc.selection) {
    const args: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(f.args)) args[k] = resolveGqlValue(val, vars);
    const input = isRecord(args.input) ? args.input : {};
    const key = f.alias ?? f.name;
    if (f.name === 'createIssue') {
      const repo = resolveGlobalId(String(input.repositoryId ?? ''));
      if (repo === null || repo.__type !== 'Repository') throw new GqlFieldError('createIssue: unknown repositoryId');
      const issue = makeIssueInRepo(repo.value as Repo, String(input.title ?? ''), String(input.body ?? ''));
      out[key] = projectValue(
        { __type: 'CreateIssuePayload', value: { issue: { __type: 'Issue', value: { repo: repo.value, issue } } } } as GqlNode,
        f.selection,
        vars,
      );
      continue;
    }
    if (f.name === 'closeIssue') {
      const target = resolveGlobalId(String(input.issueId ?? ''));
      if (target === null || target.__type !== 'Issue') throw new GqlFieldError('closeIssue: unknown issueId');
      const { issue } = target.value as { repo: Repo; issue: Issue };
      issue.state = 'closed';
      issue.updatedAt = isoOf(nextSec());
      out[key] = projectValue(
        { __type: 'CloseIssuePayload', value: { issue: target } } as GqlNode,
        f.selection,
        vars,
      );
      continue;
    }
    if (f.name === 'createPullRequest') {
      const repo = resolveGlobalId(String(input.repositoryId ?? ''));
      if (repo === null || repo.__type !== 'Repository') throw new GqlFieldError('createPullRequest: unknown repositoryId');
      const pull = makePullInRepo(
        repo.value as Repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if (pull === null) throw new GqlFieldError('createPullRequest: head or base branch does not exist, or a pull request already exists');
      out[key] = projectValue(
        { __type: 'CreatePullRequestPayload', value: { pullRequest: { __type: 'PullRequest', value: { repo: repo.value, pull } } } } as GqlNode,
        f.selection,
        vars,
      );
      continue;
    }
    if (f.name === 'mergePullRequest') {
      const target = resolveGlobalId(String(input.pullRequestId ?? ''));
      if (target === null || target.__type !== 'PullRequest') throw new GqlFieldError('mergePullRequest: unknown pullRequestId');
      const { repo, pull } = target.value as { repo: Repo; pull: Pull };
      if (pull.state !== 'open') throw new GqlFieldError('mergePullRequest: pull request is not open');
      const mergeSha = squashMerge(repo, pull);
      if (mergeSha === null) throw new GqlFieldError('mergePullRequest: merge conflict');
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = isoOf(nextSec());
      pull.mergeCommitSha = mergeSha;
      pull.updatedAt = isoOf(nextSec());
      out[key] = projectValue(
        { __type: 'MergePullRequestPayload', value: { pullRequest: target } } as GqlNode,
        f.selection,
        vars,
      );
      continue;
    }
    if (f.name === 'addComment') {
      const target = resolveGlobalId(String(input.subjectId ?? ''));
      if (target === null || target.__type !== 'Issue') throw new GqlFieldError('addComment: unknown subjectId');
      const { repo, issue } = target.value as { repo: Repo; issue: Issue };
      const id = repo.nextCommentId;
      repo.nextCommentId += 1;
      repo.seq += 1;
      const comment: Comment = {
        id,
        globalId: b64url(`IssueComment:${repo.databaseId}:${issue.number}:${id}`),
        body: String(input.body ?? ''),
        seq: repo.seq,
      };
      issue.comments.push(comment);
      issue.updatedAt = isoOf(nextSec());
      out[key] = projectValue(
        {
          __type: 'AddCommentPayload',
          value: { commentEdge: { __type: 'IssueCommentEdge', value: { node: { __type: 'IssueComment', value: comment } } } },
        } as GqlNode,
        f.selection,
        vars,
      );
      continue;
    }
    throw new GqlFieldError(`Cannot query field "${f.name}" on type "Mutation".`);
  }
  return out;
}

// Payload field resolution: the payload objects hold pre-built child nodes.
const PAYLOAD_FIELDS: Record<string, Record<string, string>> = {
  CreateIssuePayload: { issue: 'issue' },
  CloseIssuePayload: { issue: 'issue' },
  CreatePullRequestPayload: { pullRequest: 'pullRequest' },
  MergePullRequestPayload: { pullRequest: 'pullRequest' },
  AddCommentPayload: { commentEdge: 'commentEdge' },
};

function executeGraphQLOne(query: string, vars: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  let doc: GqlDocument;
  try {
    doc = new GqlParser(tokenizeGql(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  try {
    if (doc.operation === 'mutation') {
      return { data: executeMutation(doc, vars) };
    }
    const root: GqlNode = { __type: 'Query', value: {} };
    return { data: executeSelection(root, doc.selection, vars) };
  } catch (err) {
    if (err instanceof GqlFieldError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

// -------------------------------------------------------------------------------------------
// MCP (Model Context Protocol, legacy 2025-11-25 handshake + tools)
// -------------------------------------------------------------------------------------------

const MCP_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const MCP_LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpToolText(result: unknown, isError = false): Record<string, unknown> {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError };
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { rpcError: { code: -32602, message: `unknown tool ${name}` } };
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length > 0) {
    return { rpcError: { code: -32602, message: `missing required argument(s): ${missing.join(', ')}` } };
  }
  const owner = String(args.owner ?? store.viewerLogin ?? '');
  const repoName = String(args.repo ?? args.name ?? '');
  try {
    switch (name) {
      case 'create_repo': {
        const repoName2 = String(args.name ?? '');
        if (repoName2 === '') return { tool: mcpToolText('name is required', true) };
        if (store.reposByName.has(repoName2)) return { tool: mcpToolText(`repository ${repoName2} already exists`, true) };
        const repo = createRepo(repoName2, args.private === true, String(args.description ?? ''));
        if (owner !== '') {
          repo.owner = owner;
          learnViewer(owner);
        }
        return { tool: mcpToolText(repoJson(repo)) };
      }
      case 'get_repo': {
        const repo = findRepo(owner, repoName);
        if (repo === null) return { tool: mcpToolText(`repository ${owner}/${repoName} not found`, true) };
        return { tool: mcpToolText(repoJson(repo)) };
      }
      case 'create_issue': {
        const repo = findRepo(owner, repoName);
        if (repo === null) return { tool: mcpToolText(`repository ${owner}/${repoName} not found`, true) };
        const issue = makeIssueInRepo(repo, String(args.title ?? ''), String(args.body ?? ''));
        return { tool: mcpToolText(issueJson(repo, issue)) };
      }
      case 'list_issues': {
        const repo = findRepo(owner, repoName);
        if (repo === null) return { tool: mcpToolText(`repository ${owner}/${repoName} not found`, true) };
        const state = String(args.state ?? 'open');
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        list.sort((a, b) => b.seq - a.seq);
        return { tool: mcpToolText(list.map((i) => issueJson(repo, i))) };
      }
      case 'create_pull_request': {
        const repo = findRepo(owner, repoName);
        if (repo === null) return { tool: mcpToolText(`repository ${owner}/${repoName} not found`, true) };
        const pull = makePullInRepo(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? ''));
        if (pull === null) return { tool: mcpToolText('head or base branch does not exist, or a pull request already exists', true) };
        return { tool: mcpToolText(pullJson(repo, pull)) };
      }
      case 'merge_pull_request': {
        const repo = findRepo(owner, repoName);
        if (repo === null) return { tool: mcpToolText(`repository ${owner}/${repoName} not found`, true) };
        const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return { tool: mcpToolText(`pull request #${String(args.pull_number ?? '')} not found`, true) };
        if (pull.state !== 'open') return { tool: mcpToolText('pull request is already closed', true) };
        const mergeSha = squashMerge(repo, pull);
        if (mergeSha === null) return { tool: mcpToolText('merge conflict', true) };
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = isoOf(nextSec());
        pull.mergeCommitSha = mergeSha;
        pull.updatedAt = isoOf(nextSec());
        return { tool: mcpToolText(pullJson(repo, pull)) };
      }
      default:
        return { rpcError: { code: -32602, message: `unknown tool ${name}` } };
    }
  } catch (err) {
    return { tool: mcpToolText(err instanceof Error ? err.message : 'tool failed', true) };
  }
}

function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!authed(req)) {
    res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, mcpError(null, -32600, 'Invalid Request'));
    return;
  }
  const id = parsed.id ?? null;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};
  // Notifications carry no id and get no JSON-RPC answer.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, mcpError(id, -32601, 'Method not found'));
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = MCP_LEGACY_REVISIONS.includes(requested) ? requested : '2025-11-25';
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'forge', version: '1.0.0' },
    }));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const outcome = mcpCallTool(toolName, args) as { rpcError?: { code: number; message: string }; tool?: unknown };
    if (outcome.rpcError !== undefined) {
      sendJson(res, 200, mcpError(id, outcome.rpcError.code, outcome.rpcError.message));
      return;
    }
    sendJson(res, 200, mcpResult(id, outcome.tool));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// -------------------------------------------------------------------------------------------
// router + app
// -------------------------------------------------------------------------------------------

function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    errJson(res, 400, 'Invalid JSON');
    return;
  }
  const runOne = (op: unknown): unknown => {
    if (!isRecord(op) || typeof op.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const vars = isRecord(op.variables) ? (op.variables as Record<string, unknown>) : {};
    return executeGraphQLOne(op.query, vars);
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const { path } = urlOf(req);

        // Boot probe: no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch !== null) {
          if (!authed(req)) {
            errJson(res, 401, 'Requires authentication');
            return;
          }
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const tail = gitMatch[3]!;
          const body = await readBody(req);
          if (method === 'GET' && tail === 'info/refs') {
            const { query } = urlOf(req);
            const service = query.get('service') as GitService | null;
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              errJson(res, 400, 'service is required');
              return;
            }
            handleInfoRefs(req, res, owner, repoName, service);
            return;
          }
          if (method === 'POST' && tail === 'git-upload-pack') {
            const repo = findRepo(owner, repoName);
            if (repo === null) {
              errJson(res, 404, 'Not Found');
              return;
            }
            try {
              if ((req.headers['git-protocol'] ?? '') === 'version=2') handleUploadPackV2(req, res, repo, body);
              else handleUploadPackV0(req, res, repo, body);
            } catch {
              errJson(res, 400, 'malformed git request');
            }
            return;
          }
          if (method === 'POST' && tail === 'git-receive-pack') {
            const repo = findRepo(owner, repoName);
            if (repo === null) {
              errJson(res, 404, 'Not Found');
              return;
            }
            try {
              handleReceivePack(req, res, repo, body);
            } catch {
              errJson(res, 400, 'malformed git request');
            }
            return;
          }
          errJson(res, 404, 'Not Found');
          return;
        }

        // MCP endpoint.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          if (method === 'POST') {
            const body = await readBody(req);
            handleMcp(req, res, body);
            return;
          }
          errJson(res, 405, 'Method Not Allowed');
          return;
        }

        // REST + GraphQL under /api/v3.
        if (path === '/api/v3' || path === '/api/v3/') {
          if (method === 'GET') {
            sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
            return;
          }
          errJson(res, 404, 'Not Found');
          return;
        }
        if (path === '/api/v3/meta') {
          if (method === 'GET') {
            sendJson(res, 200, { installed_version: '1.0.0' });
            return;
          }
          errJson(res, 404, 'Not Found');
          return;
        }
        if (path === '/api/graphql') {
          if (method === 'POST') {
            const body = await readBody(req);
            handleGraphQL(req, res, body);
            return;
          }
          errJson(res, 404, 'Not Found');
          return;
        }
        if (path === '/api/v3/user' && method === 'GET') {
          if (!authed(req)) {
            errJson(res, 401, 'Requires authentication');
            return;
          }
          if (store.viewerLogin === null) {
            errJson(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, { login: store.viewerLogin, id: 1000, type: 'User' });
          return;
        }
        if (path === '/api/v3/user/repos') {
          if (!authed(req)) {
            errJson(res, 401, 'Requires authentication');
            return;
          }
          const body = await readBody(req);
          handleUserRepos(req, res, method, body);
          return;
        }
        if (path.startsWith('/api/v3/repos/')) {
          if (!authed(req)) {
            errJson(res, 401, 'Requires authentication');
            return;
          }
          const parts = path.split('/').slice(4).map((s) => decodeURIComponent(s));
          const owner = parts[0] ?? '';
          const name = parts[1] ?? '';
          if (owner === '' || name === '') {
            errJson(res, 404, 'Not Found');
            return;
          }
          const body = await readBody(req);
          handleRepos(req, res, owner, name, parts.slice(2), method, body);
          return;
        }
        if (path.startsWith('/api/v3/')) {
          if (!authed(req)) {
            errJson(res, 401, 'Requires authentication');
            return;
          }
          errJson(res, 404, 'Not Found');
          return;
        }

        errJson(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          try {
            errJson(res, 500, err instanceof Error ? err.message : 'internal error');
          } catch {
            // The socket is already gone; nothing more to do.
          }
        }
      }
    })();
  });
}
