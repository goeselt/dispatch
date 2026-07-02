'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { expandGlob, resolveAssets, validateAssetPath } = require('./assets.js')

test('expandGlob resolves simple file globs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'))
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'dist', 'tool-linux.tar.gz'), '')
  fs.writeFileSync(path.join(dir, 'dist', 'tool-darwin.tar.gz'), '')
  fs.writeFileSync(path.join(dir, 'dist', 'notes.txt'), '')

  assert.deepEqual(expandGlob('dist/tool-*.tar.gz', dir), ['dist/tool-darwin.tar.gz', 'dist/tool-linux.tar.gz'])
})

test('resolveAssets expands globs and preserves plain paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'))
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'README.md'), '')
  fs.writeFileSync(path.join(dir, 'dist', 'a.zip'), '')

  assert.deepEqual(resolveAssets(['README.md', 'dist/*.zip'], dir), ['README.md', 'dist/a.zip'])
})

test('resolveAssets fails when a glob matches no files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'))
  fs.mkdirSync(path.join(dir, 'dist'))

  assert.throws(() => resolveAssets(['dist/*.zip'], dir), /matched no files/)
})

test('expandGlob rejects recursive ** patterns instead of silently matching one level', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'))
  fs.mkdirSync(path.join(dir, 'dist', 'linux'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'dist', 'linux', 'tool.zip'), '')

  assert.throws(() => expandGlob('dist/**', dir), /recursive glob/)
  assert.throws(() => resolveAssets(['dist/**/*.zip'], dir), /recursive glob/)
})

test('validateAssetPath rejects assets outside the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret')

  assert.throws(() => validateAssetPath('../secret.txt', dir), /inside the workspace/)
  assert.throws(() => validateAssetPath(path.join(root, 'secret.txt'), dir), /relative to the workspace/)
})

test('validateAssetPath rejects symlinks that point outside the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret')
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(dir, 'dist', 'secret.txt'))

  assert.throws(() => validateAssetPath('dist/secret.txt', dir), /inside the workspace/)
})

test('expandGlob rejects patterns that would walk outside the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret')

  assert.throws(() => expandGlob('../*.txt', dir), /inside the workspace/)
})
