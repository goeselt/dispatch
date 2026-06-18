'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildFailureSummary,
  buildStepSummary,
  checkReleaseAuth,
  createRelease,
  createTag,
  escapeWorkflowCommand,
  expandGlob,
  fetchTag,
  isMissingReleaseError,
  parseAssets,
  parseBool,
  resolveAssets,
  runRelease,
  setupSigning,
  validateAssetPath,
  validateTagName,
} = require('./release.js')

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

test('checkReleaseAuth verifies gh authentication', () => {
  const exec = makeExec()
  checkReleaseAuth(exec)
  assert.ok(exec.called('gh', 'auth', 'status'))
})

test('fetchTag refreshes the release tag from origin', () => {
  const exec = makeExec()
  fetchTag(exec, 'v1.2.3')
  assert.ok(exec.called('git', 'fetch', '--force', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3'))
})

test('createTag deletes a local tag when pushing it fails', () => {
  const exec = makeExec({
    'git\x00push\x00origin\x00refs/tags/v1.2.3:refs/tags/v1.2.3': { status: 1, stderr: 'no permission' },
  })

  assert.throws(() => createTag(exec, 'v1.2.3'), /no permission/)
  assert.equal(exec.called('git', 'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3'), true)
  assert.equal(exec.called('git', 'tag', '-d', 'v1.2.3'), true)
})

test('isMissingReleaseError recognizes only missing release responses', () => {
  assert.equal(isMissingReleaseError('release not found'), true)
  assert.equal(isMissingReleaseError('HTTP 404: Not Found'), true)
  assert.equal(isMissingReleaseError('HTTP 401: Bad credentials'), false)
})

test('runRelease signs tags when signing-key is provided', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  runRelease(inputs({ signingKey: Buffer.from('fake-gpg-key').toString('base64') }), exec)

  assert.ok(exec.called('gpg', '--import', '--batch'), 'GPG key not imported')
  assert.ok(exec.called('git', 'config', 'tag.gpgsign', 'true'), 'tag signing not enabled')
})

test('runRelease does not configure GPG when no signing-key is given', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag': {
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

test('escapeWorkflowCommand escapes runner command separators', () => {
  assert.equal(escapeWorkflowCommand('bad%value\r\n::error::owned'), 'bad%25value%0D%0A::error::owned')
})

test('validateTagName rejects option-like and refspec-like names', () => {
  assert.equal(validateTagName('v1.2.3'), 'v1.2.3')

  for (const tag of ['--mirror', 'v1\n::error::owned', 'refs/heads/main:refs/tags/v1', 'v1^{}', '../v1']) {
    assert.throws(() => validateTagName(tag, 'release-tag'), /release-tag/)
  }
})

test('runRelease rejects unsafe release tags before command execution', () => {
  const exec = makeExec()

  assert.throws(() => runRelease(inputs({ releaseTag: '--mirror' }), exec), /release-tag must not start with -/)
  assert.deepEqual(exec.calls, [])
})

test('buildStepSummary describes the release result', () => {
  const summary = buildStepSummary(inputs({ majorTag: 'v1', minorTag: 'v1.2' }), {
    tagCreated: true,
    releaseCreated: true,
    releaseUrl: 'https://github.com/org/repo/releases/tag/v1.2.3',
    assetsUploaded: 2,
    majorTagUpdated: true,
    minorTagUpdated: true,
  })

  assert.match(summary, /## Dispatch Release/)
  assert.match(summary, /\| Release tag \| <code>v1\.2\.3<\/code> \|/)
  assert.match(summary, /\| Tag \| created \|/)
  assert.match(summary, /\| GitHub Release \| created \|/)
  assert.match(
    summary,
    /\| Release URL \| <a href="https:\/\/github\.com\/org\/repo\/releases\/tag\/v1\.2\.3">https:\/\/github\.com\/org\/repo\/releases\/tag\/v1\.2\.3<\/a> \|/,
  )
  assert.match(summary, /\| Assets uploaded \| <code>2<\/code> \|/)
  assert.match(summary, /\| Major floating tag \| v1 updated \|/)
  assert.match(summary, /\| Minor floating tag \| v1\.2 updated \|/)
})

test('buildStepSummary marks GitHub Release as skipped when create-release is false', () => {
  const summary = buildStepSummary(inputs({ createRelease: false }), {
    tagCreated: true,
    releaseCreated: false,
    releaseUrl: '',
    assetsUploaded: 0,
    majorTagUpdated: false,
    minorTagUpdated: false,
  })

  assert.match(summary, /\| GitHub Release \| skipped \|/)
  assert.match(summary, /\| Release URL \| - \|/)
})

test('buildFailureSummary describes release failures', () => {
  const summary = buildFailureSummary(new Error('token | denied'), inputs())

  assert.match(summary, /## Dispatch Release/)
  assert.match(summary, /\| Status \| failed \|/)
  assert.match(summary, /\| Release tag \| <code>v1\.2\.3<\/code> \|/)
  assert.match(summary, /\| Error \| token \\\| denied \|/)
})

test('buildFailureSummary escapes summary HTML from untrusted text', () => {
  const summary = buildFailureSummary(new Error('<script>alert(1)</script>'), inputs({ releaseTag: 'v1.2.3' }))

  assert.match(summary, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(summary, /<script>/)
})

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

test('createRelease separates asset names from gh flags', () => {
  const exec = makeExec({
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag\x00--\x00--repo\x00owner/repo': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  const url = createRelease(exec, 'v1.2.3', ['--repo', 'owner/repo'])

  assert.equal(url, 'https://github.com/org/repo/releases/tag/v1.2.3')
  assert.equal(
    exec.called('gh', 'release', 'create', 'v1.2.3', '--generate-notes', '--verify-tag', '--', '--repo', 'owner/repo'),
    true,
  )
})

test('runRelease creates tag and release', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  const result = runRelease(inputs(), exec)

  assert.equal(result.tagCreated, true)
  assert.equal(result.releaseCreated, true)
  assert.equal(result.releaseUrl, 'https://github.com/org/repo/releases/tag/v1.2.3')
  assert.equal(exec.called('git', 'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3'), true)
  assert.equal(exec.called('git', 'push', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3'), true)
  assert.equal(exec.called('gh', 'release', 'create', 'v1.2.3', '--generate-notes', '--verify-tag'), true)
})

test('runRelease checks release auth before creating a tag', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  runRelease(inputs(), exec)

  const authIdx = exec.calls.findIndex((c) => c[0] === 'gh' && c[1] === 'auth' && c[2] === 'status')
  const tagIdx = exec.calls.findIndex((c) => c[0] === 'git' && c[1] === 'tag' && c[2] === '-a')
  assert.ok(authIdx !== -1, 'gh auth status was not called')
  assert.ok(tagIdx !== -1, 'release tag was not created')
  assert.ok(authIdx < tagIdx, 'release auth must be checked before creating a tag')
})

test('runRelease fails before creating a tag when release auth fails', () => {
  const exec = makeExec({
    'gh\x00auth\x00status': { status: 1, stderr: 'not logged in' },
  })

  assert.throws(() => runRelease(inputs(), exec), /not logged in/)
  assert.equal(
    exec.calls.some((c) => c[0] === 'git' && c[1] === 'tag'),
    false,
  )
})

test('runRelease reuses existing tag and release', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': {
      stdout: '{"url":"https://github.com/org/repo/releases/tag/v1.2.3","isDraft":false}\n',
    },
  })

  const result = runRelease(inputs(), exec)

  assert.equal(result.tagCreated, false)
  assert.equal(result.releaseCreated, false)
  assert.equal(result.releaseUrl, 'https://github.com/org/repo/releases/tag/v1.2.3')
  assert.equal(exec.called('git', 'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3'), false)
  assert.equal(exec.called('git', 'fetch', '--force', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3'), true)
})

test('runRelease fetches an existing release tag before updating floating tags', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': {
      stdout: '{"url":"https://github.com/org/repo/releases/tag/v1.2.3","isDraft":false}\n',
    },
  })

  runRelease(inputs({ majorTag: 'v1' }), exec)

  const fetchIdx = exec.calls.findIndex((c) => c[0] === 'git' && c[1] === 'fetch')
  const floatingIdx = exec.calls.findIndex((c) => c[0] === 'git' && c[1] === 'tag' && c[2] === '-fa')
  assert.ok(fetchIdx !== -1, 'release tag was not fetched')
  assert.ok(floatingIdx !== -1, 'floating tag was not updated')
  assert.ok(fetchIdx < floatingIdx, 'release tag must be fetched before updating floating tags')
})

test('runRelease fails on an existing draft release instead of reusing stale state', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': {
      stdout: '{"url":"https://github.com/org/repo/releases/tag/v1.2.3","isDraft":true}\n',
    },
  })

  assert.throws(() => runRelease(inputs({ majorTag: 'v1' }), exec), /still a draft/)
  assert.equal(
    exec.calls.some((c) => c[0] === 'git' && c[1] === 'tag' && c[2] === '-fa'),
    false,
  )
})

test('runRelease fails when release lookup fails for a non-404 reason', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'HTTP 401: Bad credentials' },
  })

  assert.throws(() => runRelease(inputs({ majorTag: 'v1' }), exec), /could not check release/)
  assert.equal(
    exec.calls.some((c) => c[0] === 'gh' && c[1] === 'release' && c[2] === 'create'),
    false,
  )
  assert.equal(
    exec.calls.some((c) => c[0] === 'git' && c[1] === 'tag' && c[2] === '-fa'),
    false,
  )
})

test('runRelease can create only a tag for GoReleaser', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
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
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
  })

  assert.throws(() => runRelease(inputs({ createTag: false }), exec), /does not exist/)
})

test('runRelease uploads assets and updates floating tags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'))
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'dist', 'a.zip'), '')
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag\x00--\x00dist/a.zip': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  const result = runRelease(inputs({ assets: ['dist/*.zip'], majorTag: 'v1', minorTag: 'v1.2' }), exec, dir)

  assert.equal(result.assetsUploaded, 1)
  assert.equal(result.majorTagUpdated, true)
  assert.equal(result.minorTagUpdated, true)
  assert.equal(exec.called('gh', 'release', 'create', 'v1.2.3', '--generate-notes', '--verify-tag', '--', 'dist/a.zip'), true)
  assert.equal(exec.called('git', 'tag', '-fa', 'v1', 'v1.2.3^{}', '-m', 'Floating tag for v1.2.3'), true)
  assert.equal(
    exec.called('git', 'push', 'origin', 'refs/tags/v1:refs/tags/v1', '--force-with-lease=refs/tags/v1:'),
    true,
  )
  assert.equal(
    exec.called('git', 'push', 'origin', 'refs/tags/v1.2:refs/tags/v1.2', '--force-with-lease=refs/tags/v1.2:'),
    true,
  )
})

test('runRelease warns when assets are specified but create-release is false', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
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
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag': {
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

test('runRelease updates floating tags with an explicit force-with-lease expectation', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1': { stdout: 'abc123\trefs/tags/v1\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  runRelease(inputs({ majorTag: 'v1' }), exec)

  assert.equal(
    exec.called('git', 'push', 'origin', 'refs/tags/v1:refs/tags/v1', '--force-with-lease=refs/tags/v1:abc123'),
    true,
  )
})

test('runRelease skips asset upload when release already exists', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': {
      stdout: '{"url":"https://github.com/org/repo/releases/tag/v1.2.3","isDraft":false}\n',
    },
  })

  const result = runRelease(inputs({ assets: ['dist/*.zip'] }), exec)

  assert.equal(result.assetsUploaded, 0)
  assert.equal(
    exec.calls.some((call) => call[0] === 'gh' && call[1] === 'release' && call[2] === 'upload'),
    false,
  )
})
