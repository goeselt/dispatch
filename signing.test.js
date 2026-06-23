'use strict'

const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseSecretKeyFingerprint, setupSigning } = require('./signing.js')

function makeExec(responses = {}) {
  const calls = []
  const optionsByCall = []
  const exec = (name, args, options = {}) => {
    const call = [name, ...args]
    calls.push(call)
    optionsByCall.push({ call, options })
    const key = [name, ...args].join('\x00')
    const response = responses[key] ?? { status: 0, stdout: '', stderr: '' }
    return { status: response.status ?? 0, stdout: response.stdout ?? '', stderr: response.stderr ?? '' }
  }
  exec.calls = calls
  exec.called = (...parts) => calls.some((call) => call.join('\x00') === parts.join('\x00'))
  exec.optionsFor = (...parts) =>
    optionsByCall.find((entry) => entry.call.join('\x00') === parts.join('\x00'))?.options || {}
  return exec
}

const FINGERPRINT_RESPONSE = {
  'gpg\x00--batch\x00--list-secret-keys\x00--with-colons\x00--fingerprint': {
    stdout: 'sec:::::::::\nfpr:::::::::ABCDEF1234567890:\n',
  },
}

test('parseSecretKeyFingerprint reads the imported secret key fingerprint', () => {
  assert.equal(parseSecretKeyFingerprint('sec:::::::::\nfpr:::::::::ABCDEF:\n'), 'ABCDEF')
  assert.equal(parseSecretKeyFingerprint(''), '')
})

test('setupSigning imports the GPG key and pins it as the signing key', () => {
  const previousGnupgHome = process.env.GNUPGHOME
  const exec = makeExec(FINGERPRINT_RESPONSE)

  const cleanup = setupSigning(exec, Buffer.from('fake-gpg-key').toString('base64'))
  const gnupgHome = process.env.GNUPGHOME

  assert.ok(exec.called('gpg', '--import', '--batch'))
  assert.ok(exec.called('gpg', '--batch', '--list-secret-keys', '--with-colons', '--fingerprint'))
  assert.ok(exec.called('git', 'config', 'user.signingkey', 'ABCDEF1234567890'))
  // Signing is requested explicitly via `git tag -s`, so no tag.gpgsign config is written.
  assert.equal(exec.called('git', 'config', 'tag.gpgsign', 'true'), false)
  assert.ok(gnupgHome)
  assert.ok(fs.existsSync(gnupgHome))

  cleanup()
  assert.equal(process.env.GNUPGHOME, previousGnupgHome)
  assert.equal(fs.existsSync(gnupgHome), false)
})

test('setupSigning passes the key only over stdin, never via argv', () => {
  const secret = Buffer.from('fake-gpg-key').toString('base64')
  const exec = makeExec(FINGERPRINT_RESPONSE)

  const cleanup = setupSigning(exec, secret)
  try {
    // The base64 key must never appear as a command-line argument.
    assert.equal(
      exec.calls.some((call) => call.some((part) => String(part).includes(secret))),
      false,
    )
    // It is supplied to the import as decoded stdin input only.
    const importInput = exec.optionsFor('gpg', '--import', '--batch').input
    assert.equal(Buffer.isBuffer(importInput), true)
    assert.equal(importInput.toString(), 'fake-gpg-key')
  } finally {
    cleanup()
  }
})

test('setupSigning cleanup is idempotent', () => {
  const previousGnupgHome = process.env.GNUPGHOME
  const exec = makeExec(FINGERPRINT_RESPONSE)

  const cleanup = setupSigning(exec, Buffer.from('fake-gpg-key').toString('base64'))
  const gnupgHome = process.env.GNUPGHOME

  cleanup()
  cleanup()

  assert.equal(process.env.GNUPGHOME, previousGnupgHome)
  assert.equal(fs.existsSync(gnupgHome), false)
})

test('setupSigning cleans up and rethrows when the fingerprint is missing', () => {
  const previousGnupgHome = process.env.GNUPGHOME
  const exec = makeExec()
  let gnupgHome = ''
  const importExec = (name, args, options = {}) => {
    if (name === 'gpg' && args[0] === '--import') gnupgHome = process.env.GNUPGHOME
    return exec(name, args, options)
  }

  assert.throws(() => setupSigning(importExec, Buffer.from('fake-gpg-key').toString('base64')), /fingerprint/)
  assert.equal(process.env.GNUPGHOME, previousGnupgHome)
  assert.equal(fs.existsSync(gnupgHome), false)
})
