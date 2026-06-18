'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// GPG signing setup for release tags. The private key never touches argv or the environment:
// it is passed to `gpg --import` over stdin, and the imported keyring lives only in a private temporary GNUPGHOME
// that is removed when signing is done.

// parseSecretKeyFingerprint extracts the imported key's fingerprint from the `--with-colons` output
// of `gpg --list-secret-keys`.
function parseSecretKeyFingerprint(colonOutput) {
  for (const line of String(colonOutput ?? '').split(/\r?\n/)) {
    const fields = line.split(':')
    if (fields[0] === 'fpr' && fields[9]) return fields[9]
  }
  return ''
}

// setupSigning imports the base64-encoded private key into a throwaway keyring and configures git to sign tags with it.
// It returns a cleanup function that restores GNUPGHOME and deletes the keyring;
// the caller must invoke it once the release is done.
//
// GNUPGHOME is set on process.env on purpose: git spawns gpg itself when signing tags (`git tag -a`/`-fa`),
// and that child must inherit GNUPGHOME to find the keyring.
// Scoping it per command would not reach git's internal gpg invocation.
// GNUPGHOME is a path, not a secret, so this carries no leak risk;
// the secret key material stays in the 0700 keyring directory and is removed by cleanup.
function setupSigning(exec, signingKey) {
  const previousGnupgHome = process.env['GNUPGHOME']
  const gnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-gnupg-'))
  fs.chmodSync(gnupgHome, 0o700)
  process.env['GNUPGHOME'] = gnupgHome

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (previousGnupgHome === undefined) {
      delete process.env['GNUPGHOME']
    } else {
      process.env['GNUPGHOME'] = previousGnupgHome
    }
    fs.rmSync(gnupgHome, { recursive: true, force: true })
  }

  try {
    exec('gpg', ['--import', '--batch'], { input: Buffer.from(signingKey, 'base64') })
    const keys = exec('gpg', ['--batch', '--list-secret-keys', '--with-colons', '--fingerprint']).stdout
    const fingerprint = parseSecretKeyFingerprint(keys)
    if (!fingerprint) throw new Error('could not determine imported signing key fingerprint')
    exec('git', ['config', 'user.signingkey', fingerprint])
    exec('git', ['config', 'tag.gpgsign', 'true'])
    return cleanup
  } catch (err) {
    cleanup()
    throw err
  }
}

module.exports = {
  parseSecretKeyFingerprint,
  setupSigning,
}
