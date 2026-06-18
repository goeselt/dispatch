'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { semanticVersionParts, validateFloatingTags, validateTagName } = require('./tags.js')

function inputs(overrides = {}) {
  return {
    releaseTag: 'v1.2.3',
    majorTag: '',
    minorTag: '',
    ...overrides,
  }
}

test('validateTagName rejects option-like and refspec-like names', () => {
  assert.equal(validateTagName('v1.2.3'), 'v1.2.3')

  for (const tag of ['--mirror', 'v1\n::error::owned', 'refs/heads/main:refs/tags/v1', 'v1^{}', '../v1']) {
    assert.throws(() => validateTagName(tag, 'release-tag'), /release-tag/)
  }
})

test('semanticVersionParts reads release tag version parts', () => {
  assert.deepEqual(semanticVersionParts('v1.2.3'), { prefix: 'v', major: '1', minor: '2' })
  assert.deepEqual(semanticVersionParts('1.2.3-rc.1'), { prefix: '', major: '1', minor: '2' })
  assert.equal(semanticVersionParts('release-1'), null)
})

test('validateFloatingTags requires tags to match the release version', () => {
  assert.doesNotThrow(() => validateFloatingTags(inputs({ majorTag: 'v1', minorTag: 'v1.2' })))
  assert.throws(() => validateFloatingTags(inputs({ releaseTag: 'v2.0.0', majorTag: 'v1' })), /major-tag must be v2/)
  assert.throws(() => validateFloatingTags(inputs({ releaseTag: 'release-1', majorTag: 'v1' })), /semantic release-tag/)
})
