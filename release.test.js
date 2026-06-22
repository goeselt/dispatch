'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  checkReleaseAuth,
  createRelease,
  createTag,
  fetchTag,
  guardReleaseContext,
  guardReleaseHead,
  isMissingReleaseError,
  parseAssets,
  parseBool,
  parseMakeLatest,
  releaseCreateLatestArgs,
  runRelease,
} = require('./release.js')

function makeExec(responses = {}) {
  const calls = []
  const optionsByCall = []
  const exec = (name, args, options = {}) => {
    const call = [name, ...args]
    calls.push(call)
    optionsByCall.push({ call, options })
    const key = [name, ...args].join('\x00')
    const response = responses[key] ?? { status: 0, stdout: '', stderr: '' }
    if (response.status && !options.allowFailure) {
      throw new Error(response.stderr || response.stdout || 'command failed')
    }
    return { status: response.status ?? 0, stdout: response.stdout ?? '', stderr: response.stderr ?? '' }
  }
  exec.calls = calls
  exec.called = (...parts) => calls.some((call) => call.join('\x00') === parts.join('\x00'))
  exec.optionsFor = (...parts) =>
    optionsByCall.find((entry) => entry.call.join('\x00') === parts.join('\x00'))?.options || {}
  return exec
}

function inputs(overrides = {}) {
  return {
    releaseTag: 'v1.2.3',
    createTag: true,
    createRelease: true,
    allowNonDefaultBranch: false,
    makeLatest: 'default-branch',
    signingKey: '',
    assets: [],
    majorTag: '',
    minorTag: '',
    githubToken: '',
    gitUserName: '',
    gitUserEmail: '',
    releaseContext: {},
    ...overrides,
  }
}

function releaseContext(overrides = {}) {
  return {
    eventName: 'push',
    ref: 'refs/heads/main',
    refName: 'main',
    refType: 'branch',
    sha: 'abc123',
    defaultBranch: 'main',
    ...overrides,
  }
}

// Git/GitHub command wrappers

test('checkReleaseAuth verifies gh authentication', () => {
  const exec = makeExec()
  checkReleaseAuth(exec)
  assert.ok(exec.called('gh', 'repo', 'view', '--json', 'nameWithOwner'))
})

test('checkReleaseAuth verifies the target repository when known', () => {
  const exec = makeExec()
  checkReleaseAuth(exec, 'goeselt/dispatch')
  assert.ok(exec.called('gh', 'repo', 'view', 'goeselt/dispatch', '--json', 'nameWithOwner'))
})

test('fetchTag refreshes the release tag from origin', () => {
  const exec = makeExec()
  fetchTag(exec, 'v1.2.3')
  assert.ok(exec.called('git', 'fetch', '--force', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3'))
})

test('createTag deletes a local tag when pushing it fails', () => {
  const exec = makeExec({
    'git\x00push\x00--no-verify\x00origin\x00refs/tags/v1.2.3:refs/tags/v1.2.3': {
      status: 1,
      stderr: 'no permission',
    },
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

// Release setup orchestration

test('runRelease signs tags when signing-key is provided', () => {
  const previousGnupgHome = process.env.GNUPGHOME
  const exec = makeExec({
    'gpg\x00--batch\x00--list-secret-keys\x00--with-colons\x00--fingerprint': {
      stdout: 'sec:::::::::\nfpr:::::::::ABCDEF1234567890:\n',
    },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  runRelease(inputs({ signingKey: Buffer.from('fake-gpg-key').toString('base64') }), exec)

  assert.ok(exec.called('gpg', '--import', '--batch'), 'GPG key not imported')
  assert.ok(exec.called('git', 'config', 'user.signingkey', 'ABCDEF1234567890'), 'signing key not pinned')
  assert.ok(exec.called('git', 'config', 'tag.gpgsign', 'true'), 'tag signing not enabled')
  assert.equal(process.env.GNUPGHOME, previousGnupgHome)
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

// Input parsing and release guards

test('parseBool accepts true and false only', () => {
  assert.equal(parseBool('true', 'draft'), true)
  assert.equal(parseBool('FALSE', 'draft'), false)
  assert.throws(() => parseBool('yes', 'draft'), /must be true or false/)
})

test('parseMakeLatest accepts the supported latest policies only', () => {
  assert.equal(parseMakeLatest('default-branch'), 'default-branch')
  assert.equal(parseMakeLatest('AUTO'), 'auto')
  assert.equal(parseMakeLatest('true'), 'true')
  assert.equal(parseMakeLatest('false'), 'false')
  assert.throws(() => parseMakeLatest('legacy'), /must be default-branch, auto, true, or false/)
})

test('parseAssets trims newline-separated assets', () => {
  assert.deepEqual(parseAssets('dist/a.zip\n\n dist/b.tgz \n'), ['dist/a.zip', 'dist/b.tgz'])
})

test('runRelease rejects unsafe release tags before command execution', () => {
  const exec = makeExec()

  assert.throws(() => runRelease(inputs({ releaseTag: '--mirror' }), exec), /release-tag must not start with -/)
  assert.deepEqual(exec.calls, [])
})

test('guardReleaseContext allows default-branch releases', () => {
  assert.doesNotThrow(() => guardReleaseContext(inputs({ releaseContext: releaseContext() })))
})

test('guardReleaseContext blocks pull request events', () => {
  assert.throws(
    () =>
      guardReleaseContext(
        inputs({
          releaseContext: releaseContext({
            eventName: 'pull_request',
            ref: 'refs/pull/12/merge',
            refName: '12/merge',
          }),
        }),
      ),
    /pull request events/,
  )
})

test('guardReleaseContext blocks tag refs', () => {
  assert.throws(
    () =>
      guardReleaseContext(
        inputs({
          releaseContext: releaseContext({
            ref: 'refs/tags/v1.2.3',
            refName: 'v1.2.3',
            refType: 'tag',
          }),
        }),
      ),
    /branch refs/,
  )
})

test('guardReleaseContext blocks non-default branches unless explicitly allowed', () => {
  assert.throws(
    () =>
      guardReleaseContext(
        inputs({
          releaseContext: releaseContext({
            ref: 'refs/heads/release-candidate',
            refName: 'release-candidate',
          }),
        }),
      ),
    /default branch main/,
  )

  assert.doesNotThrow(() =>
    guardReleaseContext(
      inputs({
        allowNonDefaultBranch: true,
        releaseContext: releaseContext({
          ref: 'refs/heads/release-candidate',
          refName: 'release-candidate',
        }),
      }),
    ),
  )
})

test('guardReleaseContext blocks GitHub contexts without a default branch', () => {
  assert.throws(
    () => guardReleaseContext(inputs({ releaseContext: releaseContext({ defaultBranch: '' }) })),
    /could not determine the repository default branch/,
  )

  assert.doesNotThrow(() =>
    guardReleaseContext(
      inputs({
        allowNonDefaultBranch: true,
        releaseContext: releaseContext({ defaultBranch: '' }),
      }),
    ),
  )
})

test('runRelease checks release context before command execution', () => {
  const exec = makeExec()

  assert.throws(
    () => runRelease(inputs({ releaseContext: releaseContext({ eventName: 'pull_request' }) }), exec),
    /pull request events/,
  )
  assert.deepEqual(exec.calls, [])
})

test('guardReleaseHead allows the checkout to match the GitHub event SHA', () => {
  const exec = makeExec({
    'git\x00rev-parse\x00HEAD': { stdout: 'abc123\n' },
  })

  assert.equal(guardReleaseHead(exec, inputs({ releaseContext: releaseContext({ sha: 'abc123' }) })), 'abc123')
  assert.equal(
    exec.calls.some((call) => call[0] === 'git' && call[1] === 'merge-base'),
    false,
  )
})

test('guardReleaseHead allows a release commit created after the GitHub event SHA', () => {
  const exec = makeExec({
    'git\x00rev-parse\x00HEAD': { stdout: 'def456\n' },
    'git\x00merge-base\x00--is-ancestor\x00abc123\x00def456': { status: 0 },
  })

  assert.equal(guardReleaseHead(exec, inputs({ releaseContext: releaseContext({ sha: 'abc123' }) })), 'def456')
})

test('guardReleaseHead rejects a checkout that is unrelated to the GitHub event SHA', () => {
  const exec = makeExec({
    'git\x00rev-parse\x00HEAD': { stdout: 'def456\n' },
    'git\x00merge-base\x00--is-ancestor\x00abc123\x00def456': { status: 1 },
  })

  assert.throws(
    () => guardReleaseHead(exec, inputs({ releaseContext: releaseContext({ sha: 'abc123' }) })),
    /not an ancestor of HEAD/,
  )
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

test('releaseCreateLatestArgs keeps latest automatic on default-branch releases', () => {
  assert.deepEqual(releaseCreateLatestArgs(inputs({ releaseContext: releaseContext() })), [])
})

test('releaseCreateLatestArgs disables latest for non-default branch releases by default', () => {
  assert.deepEqual(
    releaseCreateLatestArgs(
      inputs({
        allowNonDefaultBranch: true,
        releaseContext: releaseContext({
          ref: 'refs/heads/1.x',
          refName: '1.x',
        }),
      }),
    ),
    ['--latest=false'],
  )
})

test('createRelease passes explicit latest policy to gh', () => {
  const exec = makeExec({
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag\x00--latest=false': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  const url = createRelease(exec, 'v1.2.3', [], inputs({ makeLatest: 'false' }))

  assert.equal(url, 'https://github.com/org/repo/releases/tag/v1.2.3')
  assert.equal(
    exec.called('gh', 'release', 'create', 'v1.2.3', '--generate-notes', '--verify-tag', '--latest=false'),
    true,
  )
})

test('createRelease binds gh to the GitHub event repository when available', () => {
  const exec = makeExec({
    'gh\x00release\x00create\x00v1.2.3\x00--repo\x00goeselt/dispatch\x00--generate-notes\x00--verify-tag': {
      stdout: 'https://github.com/goeselt/dispatch/releases/tag/v1.2.3\n',
    },
  })

  const url = createRelease(exec, 'v1.2.3', [], inputs({ releaseContext: { repository: 'goeselt/dispatch' } }))

  assert.equal(url, 'https://github.com/goeselt/dispatch/releases/tag/v1.2.3')
  assert.equal(
    exec.called('gh', 'release', 'create', 'v1.2.3', '--repo', 'goeselt/dispatch', '--generate-notes', '--verify-tag'),
    true,
  )
})

// Release orchestration

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
  assert.equal(exec.called('git', 'push', '--no-verify', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3'), true)
  assert.equal(exec.called('gh', 'release', 'create', 'v1.2.3', '--generate-notes', '--verify-tag'), true)
})

test('runRelease uses github-token for gh and git tag operations', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  runRelease(inputs({ githubToken: 'secret-token' }), exec)

  const ghOptions = exec.optionsFor('gh', 'repo', 'view', '--json', 'nameWithOwner')
  const lsRemoteOptions = exec.optionsFor('git', 'ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v1.2.3')
  const pushOptions = exec.optionsFor('git', 'push', '--no-verify', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3')

  const hasAuthHeader = (env) =>
    Object.values(env || {}).some((value) => String(value).startsWith('Authorization: Basic '))

  assert.equal(ghOptions.env.GH_TOKEN, 'secret-token')
  assert.equal(hasAuthHeader(lsRemoteOptions.env), true)
  assert.equal(hasAuthHeader(pushOptions.env), true)
  assert.equal(exec.optionsFor('git', 'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3').env, undefined)
  // The raw token leaks neither into the git environment nor into process.env.
  assert.equal(
    Object.values(pushOptions.env).some((value) => String(value).includes('secret-token')),
    false,
  )
  assert.equal(
    Object.values(process.env).some((value) => String(value).includes('secret-token')),
    false,
  )
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

  const authIdx = exec.calls.findIndex((c) => c[0] === 'gh' && c[1] === 'repo' && c[2] === 'view')
  const tagIdx = exec.calls.findIndex((c) => c[0] === 'git' && c[1] === 'tag' && c[2] === '-a')
  assert.ok(authIdx !== -1, 'gh repo view was not called')
  assert.ok(tagIdx !== -1, 'release tag was not created')
  assert.ok(authIdx < tagIdx, 'release auth must be checked before creating a tag')
})

test('runRelease fails before creating a tag when release auth fails', () => {
  const exec = makeExec({
    'gh\x00repo\x00view\x00--json\x00nameWithOwner': { status: 1, stderr: 'HTTP 401: bad credentials' },
  })

  assert.throws(() => runRelease(inputs(), exec), /bad credentials/)
  assert.equal(
    exec.calls.some((c) => c[0] === 'git' && c[1] === 'tag'),
    false,
  )
})

test('runRelease verifies target repository access before creating a tag', () => {
  const exec = makeExec({
    'gh\x00repo\x00view\x00goeselt/dispatch\x00--json\x00nameWithOwner': { status: 1, stderr: 'HTTP 403' },
  })

  assert.throws(() => runRelease(inputs({ releaseContext: { repository: 'goeselt/dispatch' } }), exec), /HTTP 403/)
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

test('runRelease rejects an existing release tag that points at a different commit', () => {
  const exec = makeExec({
    'git\x00rev-parse\x00HEAD': { stdout: 'abc123\n' },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'def456\trefs/tags/v1.2.3\n' },
    'git\x00rev-parse\x00v1.2.3^{}': { stdout: 'def456\n' },
  })

  assert.throws(
    () => runRelease(inputs({ releaseContext: releaseContext({ sha: 'abc123' }) }), exec),
    /release tag v1.2.3 points to def456/,
  )
  assert.equal(
    exec.calls.some((c) => c[0] === 'gh' && c[1] === 'release'),
    false,
  )
})

test('runRelease verifies a reused signed release tag', () => {
  const exec = makeExec({
    'gpg\x00--batch\x00--list-secret-keys\x00--with-colons\x00--fingerprint': {
      stdout: 'sec:::::::::\nfpr:::::::::ABCDEF1234567890:\n',
    },
    'git\x00rev-parse\x00HEAD': { stdout: 'abc123\n' },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc123\trefs/tags/v1.2.3\n' },
    'git\x00rev-parse\x00v1.2.3^{}': { stdout: 'abc123\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': {
      stdout: '{"url":"https://github.com/org/repo/releases/tag/v1.2.3","isDraft":false}\n',
    },
  })

  runRelease(
    inputs({
      signingKey: Buffer.from('fake-gpg-key').toString('base64'),
      releaseContext: releaseContext({ sha: 'abc123' }),
    }),
    exec,
  )

  assert.equal(exec.called('git', 'verify-tag', 'v1.2.3'), true)
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

test('runRelease blocks floating tags when another tool owns the release', () => {
  const exec = makeExec()

  assert.throws(
    () => runRelease(inputs({ createRelease: false, majorTag: 'v1' }), exec),
    /floating tags require create-release/,
  )
  assert.deepEqual(exec.calls, [])
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
  assert.equal(
    exec.called('gh', 'release', 'create', 'v1.2.3', '--generate-notes', '--verify-tag', '--', 'dist/a.zip'),
    true,
  )
  assert.equal(exec.called('git', 'tag', '-fa', 'v1', 'v1.2.3^{}', '-m', 'Floating tag for v1.2.3'), true)
  assert.equal(
    exec.called(
      'git',
      'push',
      '--no-verify',
      'origin',
      'refs/tags/v1:refs/tags/v1',
      '--force-with-lease=refs/tags/v1:',
    ),
    true,
  )
  assert.equal(
    exec.called(
      'git',
      'push',
      '--no-verify',
      'origin',
      'refs/tags/v1.2:refs/tags/v1.2',
      '--force-with-lease=refs/tags/v1.2:',
    ),
    true,
  )
})

test('runRelease disables latest for intentional non-default branch releases by default', () => {
  const exec = makeExec({
    'git\x00rev-parse\x00HEAD': { stdout: 'abc123\n' },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': { status: 1, stderr: 'not found' },
    'gh\x00release\x00create\x00v1.2.3\x00--generate-notes\x00--verify-tag\x00--latest=false': {
      stdout: 'https://github.com/org/repo/releases/tag/v1.2.3\n',
    },
  })

  const result = runRelease(
    inputs({
      allowNonDefaultBranch: true,
      releaseContext: releaseContext({
        ref: 'refs/heads/1.x',
        refName: '1.x',
      }),
    }),
    exec,
  )

  assert.equal(result.releaseCreated, true)
  assert.equal(
    exec.called('gh', 'release', 'create', 'v1.2.3', '--generate-notes', '--verify-tag', '--latest=false'),
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
    exec.called(
      'git',
      'push',
      '--no-verify',
      'origin',
      'refs/tags/v1:refs/tags/v1',
      '--force-with-lease=refs/tags/v1:abc123',
    ),
    true,
  )
})

test('runRelease fails when assets are requested for an existing release', () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
    'gh\x00release\x00view\x00v1.2.3\x00--json\x00url,isDraft': {
      stdout: '{"url":"https://github.com/org/repo/releases/tag/v1.2.3","isDraft":false}\n',
    },
  })

  assert.throws(() => runRelease(inputs({ assets: ['dist/*.zip'] }), exec), /assets were requested/)
  assert.equal(
    exec.calls.some((call) => call[0] === 'gh' && call[1] === 'release' && call[2] === 'upload'),
    false,
  )
})
