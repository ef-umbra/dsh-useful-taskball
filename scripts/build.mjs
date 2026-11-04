import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const placeholder = '/*__TASKBALL_CLIENT_BUNDLE__*/'
const shell = await readFile(path.join(root, 'scripts/client-shell.cjs'), 'utf8')

if (shell.split(placeholder).length !== 2) {
  throw new Error(`Client shell placeholder must occur exactly once: ${placeholder}`)
}

const amd = await readFile(path.join(root, 'lib/.client-build/bundle.js'), 'utf8')
const output = shell.replaceAll(placeholder, () => `\n${amd}`)
await writeFile(path.join(root, 'lib/client.js'), output, 'utf8')
console.log('Built lib/client.js')
