'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createTag,
  fetchTag,
  guardReleaseContext,
  guardReleaseHead,
  parseAssets,
  parseBool,
  parseMakeLatest,
  runRelease,
} = require('./release.js')

// runRelease emits [dispatch] progress lines to stdout. Silence them so they do not clutter the test reporter; the few
// tests that assert on output install their own capture inside the test body, which overrides this for their duration.
const realStdoutWrite = process.stdout.write.bind(process.stdout)
test.beforeEach(() => {
  process.stdout.write = () => true
})
test.afterEach(() => {
  process.stdout.write = realStdoutWrite
})

// makeExec mocks the synchronous git/gpg runner. When a shared trace array is passed, calls are appended to it so
// ordering can be asserted across exec (git) and api (REST) operations.
function makeExec(responses = {}, trace = null) {
  const calls = []
  const optionsByCall = []
  const exec = (name, args, options = {}) => {
    const call = [name, ...args]
    calls.push(call)
    optionsByCall.push({ call, options })
    if (trace) trace.push(['exec', ...call])
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

// makeApi mocks the GitHub REST client injected into runRelease. Overrides let a test program a return value or throw.
function makeApi(overrides = {}, trace = null) {
  const calls = []
  const record = (entry) => {
    calls.push(entry)
    if (trace) trace.push(['api', ...entry])
  }
  const api = {
    checkAuth: (repo) => {
      record(['checkAuth', repo])
      return Promise.resolve(overrides.checkAuth ? overrides.checkAuth(repo) : undefined)
    },
    getReleaseByTag: (repo, tag) => {
      record(['getReleaseByTag', repo, tag])
      return Promise.resolve(
        overrides.getReleaseByTag ? overrides.getReleaseByTag(repo, tag) : { exists: false, url: '' },
      )
    },
    createRelease: (repo, tag, assets, options) => {
      record(['createRelease', repo, tag, assets, options])
      return Promise.resolve(
        overrides.createRelease
          ? overrides.createRelease(repo, tag, assets, options)
          : `https://github.com/org/repo/releases/tag/${tag}`,
      )
    },
    getTagVerification: (repo, tagSha) => {
      record(['getTagVerification', repo, tagSha])
      return Promise.resolve(
        overrides.getTagVerification ? overrides.getTagVerification(repo, tagSha) : { verified: true },
      )
    },
  }
  api.calls = calls
  api.called = (method) => calls.some((entry) => entry[0] === method)
  api.callFor = (method) => calls.find((entry) => entry[0] === method)
  return api
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

// Git command wrappers

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

// Release setup orchestration

// A tag object body as `git cat-file -p` prints it, including the GPG signature block the signed-tag self-check looks for.
const SIGNED_TAG_BODY =
  'object 0000\ntype commit\ntag t\n\nmsg\n-----BEGIN PGP SIGNATURE-----\n\nsig\n-----END PGP SIGNATURE-----\n'

test('runRelease signs tags when signing-key is provided', async () => {
  const previousGnupgHome = process.env.GNUPGHOME
  const exec = makeExec({
    'gpg\x00--batch\x00--list-secret-keys\x00--with-colons\x00--fingerprint': {
      stdout: 'sec:::::::::\nfpr:::::::::ABCDEF1234567890:\n',
    },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'git\x00cat-file\x00-p\x00v1.2.3': { stdout: SIGNED_TAG_BODY },
  })

  await runRelease(inputs({ signingKey: Buffer.from('fake-gpg-key').toString('base64') }), exec, makeApi())

  assert.ok(exec.called('gpg', '--import', '--batch'), 'GPG key not imported')
  // The tag is created with an explicit -s (signed), and the signing key is supplied per invocation via -c rather than
  // written to .git/config. Signing must not depend on tag.gpgsign.
  assert.ok(
    exec.called('git', '-c', 'user.signingkey=ABCDEF1234567890', 'tag', '-s', 'v1.2.3', '-m', 'Release v1.2.3'),
    'tag was not signed with a per-invocation signing key',
  )
  assert.equal(
    exec.calls.some((call) => call[0] === 'git' && call[1] === 'config'),
    false,
    'signing must not persist anything to git config',
  )
  assert.equal(process.env.GNUPGHOME, previousGnupgHome)
})

test('runRelease signs floating tags when signing-key is provided', async () => {
  const exec = makeExec({
    'gpg\x00--batch\x00--list-secret-keys\x00--with-colons\x00--fingerprint': {
      stdout: 'sec:::::::::\nfpr:::::::::ABCDEF1234567890:\n',
    },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'git\x00cat-file\x00-p\x00v1.2.3': { stdout: SIGNED_TAG_BODY },
    'git\x00cat-file\x00-p\x00v1': { stdout: SIGNED_TAG_BODY },
  })

  await runRelease(
    inputs({ signingKey: Buffer.from('fake-gpg-key').toString('base64'), majorTag: 'v1' }),
    exec,
    makeApi(),
  )

  assert.ok(
    exec.called(
      'git',
      '-c',
      'user.signingkey=ABCDEF1234567890',
      'tag',
      '-f',
      '-s',
      'v1',
      'v1.2.3^{}',
      '-m',
      'Floating tag for v1.2.3',
    ),
    'floating tag was not force-signed',
  )
})

test('runRelease fails loudly when signing was requested but the created tag is not signed', async () => {
  const exec = makeExec({
    'gpg\x00--batch\x00--list-secret-keys\x00--with-colons\x00--fingerprint': {
      stdout: 'sec:::::::::\nfpr:::::::::ABCDEF1234567890:\n',
    },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    // The tag object carries no signature block, so the self-check must reject rather than push an unsigned tag.
    'git\x00cat-file\x00-p\x00v1.2.3': { stdout: 'object 0000\ntype commit\ntag t\n\nmsg\n' },
  })

  await assert.rejects(
    runRelease(inputs({ signingKey: Buffer.from('fake-gpg-key').toString('base64') }), exec, makeApi()),
    /no GPG signature/,
  )
  assert.equal(
    exec.calls.some((c) => c[0] === 'git' && c[1] === 'push'),
    false,
    'an unsigned tag must not be pushed',
  )
})

test('runRelease warns but keeps the release when a signed tag is reported unverified', async () => {
  const exec = makeExec({
    'gpg\x00--batch\x00--list-secret-keys\x00--with-colons\x00--fingerprint': {
      stdout: 'sec:::::::::\nfpr:::::::::ABCDEF1234567890:\n',
    },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'git\x00cat-file\x00-p\x00v1.2.3': { stdout: SIGNED_TAG_BODY },
    'git\x00rev-parse\x00v1.2.3^{tag}': { stdout: 'deadbeefcafe\n' },
  })
  const api = makeApi({ getTagVerification: () => ({ verified: false, reason: 'no_user' }) })

  const written = []
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (msg) => {
    written.push(msg)
    return true
  }
  let result
  try {
    result = await runRelease(inputs({ signingKey: Buffer.from('fake-gpg-key').toString('base64') }), exec, api)
  } finally {
    process.stdout.write = origWrite
  }

  // The tag and release are kept -- a no_user signature is a warning, never a rollback.
  assert.equal(result.tagCreated, true)
  assert.equal(result.releaseCreated, true)
  assert.equal(exec.called('git', 'tag', '-d', 'v1.2.3'), false, 'a published tag must not be deleted')
  assert.deepEqual(api.callFor('getTagVerification'), ['getTagVerification', undefined, 'deadbeefcafe'])
  assert.match(written.join(''), /::warning.*unverified.*no_user/)
})

test('runRelease applies the git identity per invocation and never writes to git config', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
  })

  await runRelease(inputs({ gitUserName: 'github-actions[bot]', gitUserEmail: 'bot@example.com' }), exec, makeApi())

  // Identity rides on the tag command as -c flags, leaving the checkout's .git/config untouched for later steps.
  assert.ok(
    exec.called(
      'git',
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=bot@example.com',
      'tag',
      '-a',
      'v1.2.3',
      '-m',
      'Release v1.2.3',
    ),
    'identity was not passed per invocation',
  )
  assert.equal(
    exec.calls.some((call) => call[0] === 'git' && call[1] === 'config'),
    false,
    'dispatch must not write to .git/config',
  )
})

test('runRelease does not configure GPG when no signing-key is given', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
  })

  await runRelease(inputs(), exec, makeApi())

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

test('runRelease rejects unsafe release tags before command execution', async () => {
  const exec = makeExec()

  await assert.rejects(
    runRelease(inputs({ releaseTag: '--mirror' }), exec, makeApi()),
    /release-tag must not start with -/,
  )
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

test('runRelease checks release context before command execution', async () => {
  const exec = makeExec()

  await assert.rejects(
    runRelease(inputs({ releaseContext: releaseContext({ eventName: 'pull_request' }) }), exec, makeApi()),
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

// Release orchestration

test('runRelease creates tag and release', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
  })
  const api = makeApi()

  const result = await runRelease(inputs(), exec, api)

  assert.equal(result.tagCreated, true)
  assert.equal(result.releaseCreated, true)
  assert.equal(result.releaseUrl, 'https://github.com/org/repo/releases/tag/v1.2.3')
  assert.equal(exec.called('git', 'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3'), true)
  assert.equal(exec.called('git', 'push', '--no-verify', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3'), true)
  assert.equal(api.called('createRelease'), true)
})

test('runRelease uses github-token for git tag operations', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
  })

  const previousServerUrl = process.env.GITHUB_SERVER_URL
  process.env.GITHUB_SERVER_URL = 'https://github.com'
  try {
    await runRelease(inputs({ githubToken: 'secret-token' }), exec, makeApi())
  } finally {
    if (previousServerUrl === undefined) delete process.env.GITHUB_SERVER_URL
    else process.env.GITHUB_SERVER_URL = previousServerUrl
  }

  const lsRemoteOptions = exec.optionsFor('git', 'ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v1.2.3')
  const pushOptions = exec.optionsFor('git', 'push', '--no-verify', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3')

  const hasAuthHeader = (env) =>
    Object.values(env || {}).some((value) => String(value).startsWith('Authorization: Basic '))

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

test('runRelease checks release auth before creating a tag', async () => {
  const trace = []
  const exec = makeExec(
    {
      'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    },
    trace,
  )
  const api = makeApi({}, trace)

  await runRelease(inputs(), exec, api)

  const authIdx = trace.findIndex((e) => e[0] === 'api' && e[1] === 'checkAuth')
  const tagIdx = trace.findIndex((e) => e[0] === 'exec' && e[1] === 'git' && e[2] === 'tag' && e[3] === '-a')
  assert.ok(authIdx !== -1, 'checkAuth was not called')
  assert.ok(tagIdx !== -1, 'release tag was not created')
  assert.ok(authIdx < tagIdx, 'release auth must be checked before creating a tag')
})

test('runRelease fails before creating a tag when release auth fails', async () => {
  const exec = makeExec()
  const api = makeApi({
    checkAuth: () => {
      throw new Error('GET .../repos/org/repo: HTTP 401 Must authenticate to access this API.')
    },
  })

  await assert.rejects(runRelease(inputs(), exec, api), /Must authenticate/)
  assert.equal(
    exec.calls.some((c) => c[0] === 'git' && c[1] === 'tag'),
    false,
  )
})

test('runRelease verifies target repository access before creating a tag', async () => {
  const exec = makeExec()
  const api = makeApi({
    checkAuth: () => {
      throw new Error('GET .../repos/open/dispatch: HTTP 403')
    },
  })

  await assert.rejects(runRelease(inputs({ releaseContext: { repository: 'open/dispatch' } }), exec, api), /HTTP 403/)
  assert.deepEqual(api.callFor('checkAuth'), ['checkAuth', 'open/dispatch'])
  assert.equal(
    exec.calls.some((c) => c[0] === 'git' && c[1] === 'tag'),
    false,
  )
})

test('runRelease reuses existing tag and release', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
  })
  const api = makeApi({
    getReleaseByTag: () => ({ exists: true, url: 'https://github.com/org/repo/releases/tag/v1.2.3', isDraft: false }),
  })

  const result = await runRelease(inputs(), exec, api)

  assert.equal(result.tagCreated, false)
  assert.equal(result.releaseCreated, false)
  assert.equal(result.releaseUrl, 'https://github.com/org/repo/releases/tag/v1.2.3')
  assert.equal(exec.called('git', 'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3'), false)
  assert.equal(exec.called('git', 'fetch', '--force', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3'), true)
  assert.equal(api.called('createRelease'), false)
})

test('runRelease fetches an existing release tag before updating floating tags', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
  })
  const api = makeApi({
    getReleaseByTag: () => ({ exists: true, url: 'https://github.com/org/repo/releases/tag/v1.2.3', isDraft: false }),
  })

  await runRelease(inputs({ majorTag: 'v1' }), exec, api)

  const fetchIdx = exec.calls.findIndex((c) => c[0] === 'git' && c[1] === 'fetch')
  const floatingIdx = exec.calls.findIndex((c) => c[0] === 'git' && c[1] === 'tag' && c[2] === '-f' && c[3] === '-a')
  assert.ok(fetchIdx !== -1, 'release tag was not fetched')
  assert.ok(floatingIdx !== -1, 'floating tag was not updated')
  assert.ok(fetchIdx < floatingIdx, 'release tag must be fetched before updating floating tags')
})

test('runRelease rejects an existing release tag that points at a different commit', async () => {
  const exec = makeExec({
    'git\x00rev-parse\x00HEAD': { stdout: 'abc123\n' },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'def456\trefs/tags/v1.2.3\n' },
    'git\x00rev-parse\x00v1.2.3^{}': { stdout: 'def456\n' },
  })
  const api = makeApi()

  await assert.rejects(
    runRelease(inputs({ releaseContext: releaseContext({ sha: 'abc123' }) }), exec, api),
    /release tag v1.2.3 points to def456/,
  )
  assert.equal(api.called('createRelease'), false)
})

test('runRelease verifies a reused signed release tag', async () => {
  const exec = makeExec({
    'gpg\x00--batch\x00--list-secret-keys\x00--with-colons\x00--fingerprint': {
      stdout: 'sec:::::::::\nfpr:::::::::ABCDEF1234567890:\n',
    },
    'git\x00rev-parse\x00HEAD': { stdout: 'abc123\n' },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc123\trefs/tags/v1.2.3\n' },
    'git\x00rev-parse\x00v1.2.3^{}': { stdout: 'abc123\n' },
  })
  const api = makeApi({
    getReleaseByTag: () => ({ exists: true, url: 'https://github.com/org/repo/releases/tag/v1.2.3', isDraft: false }),
  })

  await runRelease(
    inputs({
      signingKey: Buffer.from('fake-gpg-key').toString('base64'),
      releaseContext: releaseContext({ sha: 'abc123' }),
    }),
    exec,
    api,
  )

  assert.equal(exec.called('git', 'verify-tag', 'v1.2.3'), true)
})

test('runRelease fails on an existing draft release instead of reusing stale state', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
  })
  const api = makeApi({
    getReleaseByTag: () => ({ exists: true, url: 'https://github.com/org/repo/releases/tag/v1.2.3', isDraft: true }),
  })

  await assert.rejects(runRelease(inputs({ majorTag: 'v1' }), exec, api), /still a draft/)
  assert.equal(
    exec.calls.some((c) => c[0] === 'git' && c[1] === 'tag' && c[2] === '-f'),
    false,
  )
})

test('runRelease fails when release lookup fails for a non-404 reason', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
  })
  const api = makeApi({
    getReleaseByTag: () => {
      throw new Error('GET .../releases/tags/v1.2.3: HTTP 401 Bad credentials')
    },
  })

  await assert.rejects(runRelease(inputs({ majorTag: 'v1' }), exec, api), /HTTP 401/)
  assert.equal(api.called('createRelease'), false)
  assert.equal(
    exec.calls.some((c) => c[0] === 'git' && c[1] === 'tag' && c[2] === '-f'),
    false,
  )
})

test('runRelease can create only a tag for GoReleaser', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
  })
  const api = makeApi()

  const result = await runRelease(inputs({ createRelease: false }), exec, api)

  assert.equal(result.tagCreated, true)
  assert.equal(result.releaseCreated, false)
  assert.equal(api.calls.length, 0, 'no GitHub API calls expected when create-release is false')
})

test('runRelease blocks floating tags when another tool owns the release', async () => {
  const exec = makeExec()

  await assert.rejects(
    runRelease(inputs({ createRelease: false, majorTag: 'v1' }), exec, makeApi()),
    /floating tags require create-release/,
  )
  assert.deepEqual(exec.calls, [])
})

test('runRelease fails when tag is missing and createTag is false', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
  })

  await assert.rejects(runRelease(inputs({ createTag: false }), exec, makeApi()), /does not exist/)
})

test('runRelease uploads assets and updates floating tags', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'))
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'dist', 'a.zip'), '')
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
  })
  const api = makeApi()

  const result = await runRelease(inputs({ assets: ['dist/*.zip'], majorTag: 'v1', minorTag: 'v1.2' }), exec, api, dir)

  assert.equal(result.assetsUploaded, 1)
  assert.equal(result.majorTagUpdated, true)
  assert.equal(result.minorTagUpdated, true)

  const createCall = api.callFor('createRelease')
  assert.ok(createCall, 'createRelease was not called')
  // Assets are passed as absolute paths resolved against the validating workspace, not process.cwd()-relative.
  assert.deepEqual(createCall[3], [path.join(dir, 'dist', 'a.zip')])

  assert.equal(exec.called('git', 'tag', '-f', '-a', 'v1', 'v1.2.3^{}', '-m', 'Floating tag for v1.2.3'), true)
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

test('runRelease passes the non-default branch context through to the release client', async () => {
  const exec = makeExec({
    'git\x00rev-parse\x00HEAD': { stdout: 'abc123\n' },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
  })
  const api = makeApi()

  const result = await runRelease(
    inputs({
      allowNonDefaultBranch: true,
      releaseContext: releaseContext({
        ref: 'refs/heads/1.x',
        refName: '1.x',
      }),
    }),
    exec,
    api,
  )

  assert.equal(result.releaseCreated, true)
  const createCall = api.callFor('createRelease')
  assert.ok(createCall, 'createRelease was not called')
  assert.equal(createCall[4].releaseContext.refName, '1.x')
})

test('runRelease warns when assets are specified but create-release is false', async () => {
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
    await runRelease(inputs({ createRelease: false, assets: ['dist/*.zip'] }), exec, makeApi())
  } finally {
    process.stdout.write = origWrite
  }
  assert.ok(written.some((line) => line.includes('::warning') && line.includes('create-release is false')))
})

test('runRelease emits namespaced [dispatch] progress for the path it takes', async () => {
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
    await runRelease(inputs({ majorTag: 'v1' }), exec, makeApi())
  } finally {
    process.stdout.write = origWrite
  }
  const log = written.join('')
  assert.match(log, /\[dispatch\] preparing release v1\.2\.3/)
  assert.match(log, /\[dispatch\] created and pushed tag v1\.2\.3/)
  assert.match(log, /\[dispatch\] created GitHub Release v1\.2\.3/)
  assert.match(log, /\[dispatch\] updated floating tag v1 -> v1\.2\.3/)
})

test('runRelease updates floating tags after creating the release', async () => {
  const trace = []
  const exec = makeExec(
    {
      'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    },
    trace,
  )
  const api = makeApi({}, trace)

  await runRelease(inputs({ majorTag: 'v1' }), exec, api)

  const releaseIdx = trace.findIndex((e) => e[0] === 'api' && e[1] === 'createRelease')
  const floatingIdx = trace.findIndex(
    (e) => e[0] === 'exec' && e[1] === 'git' && e[2] === 'tag' && e[3] === '-f' && e[4] === '-a',
  )
  assert.ok(releaseIdx !== -1, 'createRelease was not called')
  assert.ok(floatingIdx !== -1, 'git tag -f -a was not called')
  assert.ok(releaseIdx < floatingIdx, 'floating tag must be updated after release is created')
})

test('runRelease updates floating tags with an explicit force-with-lease expectation', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: '' },
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1': { stdout: 'abc123\trefs/tags/v1\n' },
  })

  await runRelease(inputs({ majorTag: 'v1' }), exec, makeApi())

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

test('runRelease fails when assets are requested for an existing release', async () => {
  const exec = makeExec({
    'git\x00ls-remote\x00--tags\x00--refs\x00origin\x00refs/tags/v1.2.3': { stdout: 'abc\trefs/tags/v1.2.3\n' },
  })
  const api = makeApi({
    getReleaseByTag: () => ({ exists: true, url: 'https://github.com/org/repo/releases/tag/v1.2.3', isDraft: false }),
  })

  await assert.rejects(runRelease(inputs({ assets: ['dist/*.zip'] }), exec, api), /assets were requested/)
  assert.equal(api.called('createRelease'), false)
})
