'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { input } = require('./index.js')

function withEnv(name, value, fn) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test('input returns a provided value', () => {
  withEnv('INPUT_GIT-USER-NAME', 'octocat', () => {
    assert.equal(input('GIT-USER-NAME', 'fallback'), 'octocat')
  })
})

test('input falls back when the variable is absent', () => {
  withEnv('INPUT_GIT-USER-NAME', undefined, () => {
    assert.equal(input('GIT-USER-NAME', 'fallback'), 'fallback')
  })
})

// GitHub Actions sets INPUT_<NAME> to an empty string for inputs declared with an empty default. The fallback must
// still apply, or git-user-name/email would be configured empty and `git tag -a` would fail with "empty ident name".
test('input falls back when the variable is the empty string that Actions injects for an empty default', () => {
  withEnv('INPUT_GIT-USER-NAME', '', () => {
    assert.equal(input('GIT-USER-NAME', 'github-actions[bot]'), 'github-actions[bot]')
  })
})
