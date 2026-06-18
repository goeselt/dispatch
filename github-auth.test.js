'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { gitAuthEnv, needsGitHubToken, withGitHubToken } = require('./github-auth.js')

function makeExec() {
  const calls = []
  const optionsByCall = []
  const exec = (name, args, options = {}) => {
    const call = [name, ...args]
    calls.push(call)
    optionsByCall.push({ call, options })
    return { status: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  exec.optionsFor = (...parts) =>
    optionsByCall.find((entry) => entry.call.join('\x00') === parts.join('\x00'))?.options || {}
  return exec
}

test('needsGitHubToken scopes auth to gh and git network commands', () => {
  assert.equal(needsGitHubToken('gh', ['auth', 'status']), true)
  assert.equal(needsGitHubToken('git', ['fetch', 'origin']), true)
  assert.equal(needsGitHubToken('git', ['ls-remote', 'origin']), true)
  assert.equal(needsGitHubToken('git', ['push', 'origin']), true)
  assert.equal(needsGitHubToken('git', ['tag', '-a', 'v1.2.3']), false)
  assert.equal(needsGitHubToken('gpg', ['--version']), false)
})

function withEnv(overrides, fn) {
  const previous = {}
  for (const [name, value] of Object.entries(overrides)) {
    previous[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return fn()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('gitAuthEnv resets generic and URL-specific extraheaders before appending ours', () => {
  withEnv({ GITHUB_SERVER_URL: 'https://github.example.com/', GIT_CONFIG_COUNT: undefined }, () => {
    const env = gitAuthEnv('secret-token')
    const expectedHeader = `Authorization: Basic ${Buffer.from('x-access-token:secret-token').toString('base64')}`
    const urlKey = 'http.https://github.example.com/.extraheader'

    assert.equal(env.GIT_TERMINAL_PROMPT, '0')
    assert.equal(env.GIT_CONFIG_COUNT, '3')
    // Generic key reset, then URL-specific reset, then our header.
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraheader')
    assert.equal(env.GIT_CONFIG_VALUE_0, '')
    assert.equal(env.GIT_CONFIG_KEY_1, urlKey)
    assert.equal(env.GIT_CONFIG_VALUE_1, '')
    assert.equal(env.GIT_CONFIG_KEY_2, urlKey)
    assert.equal(env.GIT_CONFIG_VALUE_2, expectedHeader)
    assert.equal(
      Object.values(env).some((value) => String(value).includes('secret-token')),
      false,
    )
  })
})

test('gitAuthEnv appends after GIT_CONFIG_* already present in the environment', () => {
  withEnv({ GITHUB_SERVER_URL: 'https://github.com', GIT_CONFIG_COUNT: '2' }, () => {
    const env = gitAuthEnv('secret-token')

    // Existing indices 0 and 1 are left untouched; ours start at index 2.
    assert.equal(env.GIT_CONFIG_COUNT, '5')
    assert.equal(env.GIT_CONFIG_KEY_0, undefined)
    assert.equal(env.GIT_CONFIG_KEY_1, undefined)
    assert.equal(env.GIT_CONFIG_KEY_2, 'http.extraheader')
    assert.equal(env.GIT_CONFIG_KEY_3, 'http.https://github.com/.extraheader')
    assert.equal(env.GIT_CONFIG_VALUE_3, '')
    assert.equal(env.GIT_CONFIG_KEY_4, 'http.https://github.com/.extraheader')
    assert.equal(env.GIT_CONFIG_VALUE_4.startsWith('Authorization: Basic '), true)
  })
})

test('withGitHubToken injects token only into scoped child command environments', () => {
  const exec = makeExec()

  withEnv({ GITHUB_SERVER_URL: 'https://github.com', GIT_CONFIG_COUNT: undefined }, () => {
    withGitHubToken(exec, 'secret-token', (authExec) => {
      authExec('gh', ['auth', 'status'])
      authExec('git', ['push', '--no-verify', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3'])
      authExec('git', ['tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3'])
      authExec('gpg', ['--version'])
    })

    const pushEnv = exec.optionsFor('git', 'push', '--no-verify', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3').env
    assert.equal(pushEnv.GIT_CONFIG_KEY_2, 'http.https://github.com/.extraheader')
    assert.equal(pushEnv.GIT_CONFIG_VALUE_2.startsWith('Authorization: Basic '), true)
    assert.equal(exec.optionsFor('gh', 'auth', 'status').env.GH_TOKEN, 'secret-token')
    assert.equal(exec.optionsFor('git', 'tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3').env, undefined)
    assert.equal(exec.optionsFor('gpg', '--version').env, undefined)
  })

  assert.equal(
    Object.values(process.env).some((value) => String(value).includes('secret-token')),
    false,
  )
})
