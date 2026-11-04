import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await copyFile(
  path.join(root, 'lib/.model-build/model.js'),
  path.join(root, 'lib/model.mjs'),
)
console.log('Built lib/model.mjs')
