'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { expandGlob, parseAssets, parseBool, resolveAssets, runRelease, setupSigning } = require('./release.js')

function makeExec(responses = {}) {
  const calls = []
  const exec = (name, args, options = {}) => {
    calls.push([name, ...args])
    const key = [name, ...args].join('\x00')
    const response = responses[key] ?? { status: 0, stdout: '', stderr: '' }
    if (response.status && !options.allowFailure) {
      throw new Error(response.stderr || response.stdout || 'command failed')
    }
    return { status: response.status ?? 0, stdout: response.stdout ?? '', stderr: response.stderr ?? '' }
  }
  exec.calls = calls
  exec.called = (...parts) => calls.some((call) => call.join('\x00') === parts.join('\x00'))
  return exec
}

function inputs(overrides = {}) {
  return {
    releaseTag: 'v1.2.3',
    createTag: true,
    createRelease: true,
    signingKey: '',
    assets: [],
    majorTag: '',
    minorTag: '',
    gitUserName: '',
    gitUserEmail: '',
    ...overrides,
  }
}

test('setupSigning imports the GPG key and enables tag signing', () => {
  const exec = makeExec()
  setupSigning(exec, Buffer.from('fake-gpg-key').toString('base64'))
  assert.ok(exec.called('gpg', '--import', '--batch'))
  assert.ok(exec.called('git', 'config', 'tag.gpgsign', 'true'))
})

test('runRelease signs tags when signing-key is provided', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url\x00--jq\x00.url': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  runRelease(inputs({ signingKey: Buffer.from('fake-gpg-key').toString('base64') }), exec)

  assert.ok(exec.called('gpg', '--import', '--batch'), 'GPG key not imported')
  assert.ok(exec.called('git', 'config', 'tag.gpgsign', 'true'), 'tag signing not enabled')
})

test('runRelease does not configure GPG when no signing-key is given', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url\x00--jq\x00.url': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  runRelease(inputs(), exec)

  assert.equal(
    exec.calls.some((c) => c[0] === 'gpg'),
    false,
    'unexpected GPG call without signing-key',
  )
})

test('parseBool accepts true and false only', () => {
  assert.equal(parseBool('true', 'draft'), true)
  assert.equal(parseBool('FALSE', 'draft'), false)
  assert.throws(() => parseBool('yes', 'draft'), /must be true or false/)
})

test('parseAssets trims newline-separated assets', () => {
  assert.deepEqual(parseAssets('dist/a.zip\n\n dist/b.tgz \n'), ['dist/a.zip', 'dist/b.tgz'])
})

test('expandGlob resolves simple file globs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipit-'))
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'dist', 'tool-linux.tar.gz'), '')
  fs.writeFileSync(path.join(dir, 'dist', 'tool-darwin.tar.gz'), '')
  fs.writeFileSync(path.join(dir, 'dist', 'notes.txt'), '')

  assert.deepEqual(expandGlob('dist/tool-*.tar.gz', dir), ['dist/tool-darwin.tar.gz', 'dist/tool-linux.tar.gz'])
})

test('resolveAssets expands globs and preserves plain paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipit-'))
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'dist', 'a.zip'), '')

  assert.deepEqual(resolveAssets(['README.md', 'dist/*.zip'], dir), ['README.md', 'dist/a.zip'])
})

test('runRelease creates tag and release', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url\x00--jq\x00.url': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  const result = runRelease(inputs(), exec)

  assert.equal(result.tagCreated, true)
  assert.equal(result.releaseCreated, true)
  assert.equal(result.releaseUrl, 'https://github.com/org/repo/releases/tag/v1.2.3')
  assert.equal(exec.called('git', 'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3'), true)
  assert.equal(exec.called('git', 'push', 'origin', 'v1.2.3'), true)
})

test('runRelease reuses existing tag and release', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url\x00--jq\x00.url': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  const result = runRelease(inputs(), exec)

  assert.equal(result.tagCreated, false)
  assert.equal(result.releaseCreated, false)
  assert.equal(result.releaseUrl, 'https://github.com/org/repo/releases/tag/v1.2.3')
  assert.equal(exec.called('git', 'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3'), false)
})

test('runRelease can create only a tag for GoReleaser', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: '' },
  })

  const result = runRelease(inputs({ createRelease: false }), exec)

  assert.equal(result.tagCreated, true)
  assert.equal(result.releaseCreated, false)
  assert.equal(
    exec.calls.some((call) => call[0] === 'gh'),
    false,
  )
})

test('runRelease fails when tag is missing and createTag is false', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: '' },
  })

  assert.throws(() => runRelease(inputs({ createTag: false }), exec), /does not exist/)
})

test('runRelease uploads assets and updates floating tags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipit-'))
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'dist', 'a.zip'), '')
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url\x00--jq\x00.url': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  const result = runRelease(inputs({ assets: ['dist/*.zip'], majorTag: 'v1', minorTag: 'v1.2' }), exec, dir)

  assert.equal(result.assetsUploaded, 1)
  assert.equal(result.majorTagUpdated, true)
  assert.equal(result.minorTagUpdated, true)
  assert.equal(exec.called('gh', 'release', 'upload', 'v1.2.3', 'dist/a.zip'), true)
  assert.equal(exec.called('git', 'tag', '-fa', 'v1', 'v1.2.3^{}', '-m', 'Floating tag for v1.2.3'), true)
  assert.equal(exec.called('git', 'push', 'origin', 'v1', '--force'), true)
  assert.equal(exec.called('git', 'push', 'origin', 'v1.2', '--force'), true)
})

test('runRelease warns when assets are specified but create-release is false', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: '' },
  })
  const written = []
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (msg) => {
    written.push(msg)
    return true
  }
  try {
    runRelease(inputs({ createRelease: false, assets: ['dist/*.zip'] }), exec)
  } finally {
    process.stdout.write = origWrite
  }
  assert.ok(written.some((line) => line.includes('::warning') && line.includes('create-release is false')))
})

test('runRelease updates floating tags after creating the release', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url\x00--jq\x00.url': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  runRelease(inputs({ majorTag: 'v1' }), exec)

  const releaseIdx = exec.calls.findIndex((c) => c[0] === 'gh' && c[1] === 'release' && c[2] === 'create')
  const floatingIdx = exec.calls.findIndex((c) => c[0] === 'git' && c[1] === 'tag' && c[2] === '-fa')
  assert.ok(releaseIdx !== -1, 'gh release create was not called')
  assert.ok(floatingIdx !== -1, 'git tag -fa was not called')
  assert.ok(releaseIdx < floatingIdx, 'floating tag must be updated after release is created')
})

test('runRelease skips asset upload when release already exists', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00origin\x00v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url\x00--jq\x00.url': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  const result = runRelease(inputs({ assets: ['dist/*.zip'] }), exec)

  assert.equal(result.assetsUploaded, 0)
  assert.equal(
    exec.calls.some((call) => call[0] === 'gh' && call[1] === 'release' && call[2] === 'upload'),
    false,
  )
})
