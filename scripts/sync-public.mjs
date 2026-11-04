#!/usr/bin/env node
/**
 * Publish a clean snapshot of this repository to the PUBLIC mirror.
 *
 * The private repository is the only place development happens; the public
 * repository exists so other people can read the source and so npm's
 * `repository` field points somewhere real. Nothing here runs automatically —
 * it is a deliberate step taken when a release is about to be published.
 *
 * WHY A WHITELIST, NOT A BLACKLIST: a blacklist leaks the moment someone adds a
 * file that the list does not mention. A whitelist leaks only if a file is
 * ADDED to it by mistake, which is visible in the diff of this very file.
 *
 * Usage:
 *   node scripts/sync-public.mjs --dry-run      # report what would sync
 *   node scripts/sync-public.mjs --init         # first time: create the snapshot
 *   node scripts/sync-public.mjs                # update an existing snapshot
 *   node scripts/sync-public.mjs --push         # also commit + push
 *
 * The target directory defaults to `../dsh-useful-taskball-public` and can be
 * overridden with `PUBLIC_DIR`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The ONLY things that may appear in the public repository.
 *
 * Adding an entry here is a publication decision. Everything not listed stays
 * private, including: `docs/` (DEVLOG / DECISION / incident reports /
 * machine-specific reference), `AGENTS.md`, `DECISION.md`, `resource/`, `temp/`,
 * `.mnemon/`, `lib/`, `node_modules/`.
 */
const WHITELIST = [
  // Source, tests and the gates that keep them honest.
  'src',
  'test',
  'scripts',
  // Display metadata and artwork.
  'locale',
  'icon.svg',
  // Build inputs, so `npm install` from the public clone can rebuild `lib/`.
  'package.json',
  'tsconfig.json',
  'tsconfig.client.json',
  'tsconfig.model.json',
  'cordis.patch.yml',
  // User-facing documents.
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
]

/**
 * Files copied under a DIFFERENT name in the public repository.
 *
 * `.gitignore` itself cannot be published: this repository's copy excludes the
 * private documents (`AGENTS.md`, `DECISION.md`, `docs/`, `.mnemon/`) and its
 * comments describe them, so shipping it would publish a map of exactly what is
 * being withheld. `.gitignore.public` is the public-facing replacement.
 */
const RENAMED = [
  ['.gitignore.public', '.gitignore'],
]

/**
 * Patterns that must NEVER reach the public repository. The whitelist already
 * excludes them, but this is a second, independent check: if someone later adds
 * `docs` to WHITELIST by mistake, this still refuses.
 */
const FORBIDDEN = [
  // Built from fragments so this file does not trip its own scan (§13 cause ②:
  // a gate matching its own documentation). A literal absolute-path pattern
  // here would be found by the very check that looks for it.
  new RegExp(`${'C'}:${'\\\\'}${'Users'}`, 'i'),
  new RegExp(`${'C'}:/${'Users'}/`, 'i'),
  new RegExp(`/${'Users'}/[A-Za-z0-9._-]+/${'AppData'}`, 'i'),
  // The author's machine id appears inside old absolute paths.
  new RegExp(`19${'349'}`),
  /BEGIN (RSA|OPENSSH|EC) PRIVATE KEY/,
  /\bnpm_[A-Za-z0-9]{36}/, // npm tokens
  /ghp_[A-Za-z0-9]{36}/, // GitHub personal access tokens
  /\bsk-[A-Za-z0-9]{20,}/, // API keys
]

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.svg', '.txt', '.gitignore'])

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const init = args.has('--init')
const push = args.has('--push')

const PUBLIC_DIR = resolve(ROOT, process.env.PUBLIC_DIR ?? '../dsh-useful-taskball-public')

function fail(message) {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

/** Walk a directory and yield every regular file path relative to `ROOT`. */
function* walk(prefix) {
  const absolute = join(ROOT, prefix)
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) yield* walk(rel)
    else if (entry.isFile()) yield rel
  }
}

// ---------------------------------------------------------------------------
// 1. Scan every file that would be published, before copying anything.
// ---------------------------------------------------------------------------
const missing = WHITELIST.filter((item) => !existsSync(join(ROOT, item)))
if (missing.length > 0) fail(`whitelist entries missing from the repository: ${missing.join(', ')}`)

const files = []
for (const item of WHITELIST) {
  const absolute = join(ROOT, item)
  if (statSync(absolute).isDirectory()) {
    for (const rel of walk(item)) files.push(rel)
  } else {
    files.push(item)
  }
}
for (const [source] of RENAMED) files.push(source)

const findings = []
for (const file of files) {
  const ext = file.slice(file.lastIndexOf('.'))
  if (!TEXT_EXT.has(ext) && ext !== '') continue
  const text = readFileSync(join(ROOT, file), 'utf8')
  for (const pattern of FORBIDDEN) {
    if (pattern.test(text)) {
      findings.push(`${file} matches ${pattern}`)
      break
    }
  }
}

if (findings.length > 0) {
  console.error('\n✖ Refusing to publish: forbidden content found.')
  for (const finding of findings) console.error(`   ${finding}`)
  console.error('\n   Fix the source file, do not weaken this check.')
  process.exit(1)
}

// The public clone must be able to rebuild `lib/` from source, or the npm
// `prepack` hook fails there. Verify the build inputs are actually present.
for (const required of ['scripts/build.mjs', 'scripts/copy-model.mjs', 'scripts/client-shell.cjs']) {
  if (!files.includes(required)) fail(`build input ${required} is not in the whitelist — the public clone could not run prepack`)
}

const totalBytes = files.reduce((sum, file) => sum + statSync(join(ROOT, file)).size, 0)
console.log(`\nPublic snapshot: ${files.length} files, ${(totalBytes / 1024).toFixed(1)} KB`)
console.log(`Target: ${PUBLIC_DIR}`)

if (dryRun) {
  console.log('\n--dry-run: nothing was written. Files that would sync:')
  for (const file of files.sort()) console.log(`   ${file}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 2. Materialize the snapshot. Only the whitelist is copied; anything else that
//    happens to sit in the target directory is removed.
// ---------------------------------------------------------------------------
if (init) {
  if (existsSync(join(PUBLIC_DIR, '.git'))) {
    fail(`--init refuses to run: ${PUBLIC_DIR} already has a .git directory`)
  }
  if (existsSync(PUBLIC_DIR)) rmSync(PUBLIC_DIR, { recursive: true, force: true })
  mkdirSync(PUBLIC_DIR, { recursive: true })
  console.log('\nInitialised an empty public directory.')
} else {
  if (!existsSync(join(PUBLIC_DIR, '.git'))) {
    fail(`${PUBLIC_DIR} is not a git repository — run with --init the first time`)
  }
  // Clear tracked content but keep `.git` so the history survives.
  for (const entry of readdirSync(PUBLIC_DIR)) {
    if (entry === '.git') continue
    rmSync(join(PUBLIC_DIR, entry), { recursive: true, force: true })
  }
}

for (const item of WHITELIST) {
  cpSync(join(ROOT, item), join(PUBLIC_DIR, item), { recursive: true })
}
for (const [source, target] of RENAMED) {
  cpSync(join(ROOT, source), join(PUBLIC_DIR, target))
}
console.log(`\n✓ Copied ${files.length} files.`)

// ---------------------------------------------------------------------------
// 3. Optionally commit and push.
// ---------------------------------------------------------------------------
if (!push) {
  console.log('\nNot pushed (pass --push to commit and push).')
  process.exit(0)
}

const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: PUBLIC_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// `git commit` fails with "Author identity unknown" on a machine whose git
// identity was never configured (a fresh clone in CI, a new laptop). Passing the
// identity per command keeps this script self-sufficient without touching the
// user's global git config.
const identity = []
if (process.env.PUBLIC_GIT_NAME === undefined || process.env.PUBLIC_GIT_EMAIL === undefined) {
  // Fall back to the private repo's own identity, which is already configured
  // (D-014 pins it repository-wide).
  let name = 'ef-umbra'
  let email = '319873670+ef-umbra@users.noreply.github.com'
  try {
    name = execFileSync('git', ['config', 'user.name'], { cwd: ROOT, encoding: 'utf8' }).trim() || name
    email = execFileSync('git', ['config', 'user.email'], { cwd: ROOT, encoding: 'utf8' }).trim() || email
  } catch {
    // Keep the pinned defaults above.
  }
  identity.push('-c', `user.name=${name}`, '-c', `user.email=${email}`)
} else {
  identity.push('-c', `user.name=${process.env.PUBLIC_GIT_NAME}`, '-c', `user.email=${process.env.PUBLIC_GIT_EMAIL}`)
}

try {
  git('add', '-A')
  const status = git('status', '--porcelain')
  if (status.trim() === '') {
    console.log('\nNothing changed — no commit made.')
    process.exit(0)
  }
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  // The `-c` flags must precede the subcommand.
  execFileSync('git', [...identity, 'commit', '-m', `sync: ${version}`], { cwd: PUBLIC_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('push', 'origin', 'HEAD')
  console.log(`\n✓ Committed and pushed as "sync: ${version}".`)
} catch (error) {
  fail(`git failed: ${(error.stderr ?? error.message).toString().trim()}`)
}
