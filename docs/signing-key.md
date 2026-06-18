# Signing Key Setup

Dispatch can sign the annotated Git tags it creates. Signed tags give consumers a stronger signal that a release tag was
created by the expected release workflow and was not replaced by someone with tag push access. When `signing-key` is set,
dispatch also verifies an existing release tag before reusing it, so reruns do not silently build on an unsigned or
unexpected tag.

Use a dedicated release signing key for CI. Do not reuse a personal developer key.

## Create A Release Signing Key

These commands work in a default Debian shell.

```bash
sudo apt-get update
sudo apt-get install -y gnupg
```

Choose the identity that should appear on signed release tags:

```bash
export KEY_NAME="Dispatch Release"
export KEY_EMAIL="release-bot@example.com"
```

Generate a signing-only Ed25519 key without a passphrase:

```bash
cat > signing-key.batch <<EOF
%no-protection
Key-Type: eddsa
Key-Curve: ed25519
Key-Usage: sign
Name-Real: ${KEY_NAME}
Name-Email: ${KEY_EMAIL}
Expire-Date: 2y
%commit
EOF

gpg --batch --generate-key signing-key.batch
```

Export the key id:

```bash
export KEY_ID="$(gpg --list-secret-keys --with-colons "${KEY_EMAIL}" | awk -F: '$1 == "sec" { print $5; exit }')"
gpg --list-secret-keys --keyid-format=long "${KEY_ID}"
```

Export the private key for GitHub Actions and the public key for consumers:

```bash
gpg --armor --export-secret-keys "${KEY_ID}" | base64 -w0 > release-signing-key.base64
gpg --armor --export "${KEY_ID}" > release-signing-key.asc
```

Store the full single-line content of `release-signing-key.base64` as a GitHub Actions secret named
`RELEASE_SIGNING_KEY`. Do not commit this file.

The public key in `release-signing-key.asc` may be committed to the repository or published wherever consumers expect to
find release verification material.

## Use The Key In Dispatch

```yaml
permissions:
  contents: write

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0

  - uses: goeselt/dispatch@v1
    with:
      release-tag: ${{ steps.version.outputs.release-tag }}
      major-tag: ${{ steps.version.outputs.major-tag }}
      minor-tag: ${{ steps.version.outputs.minor-tag }}
      signing-key: ${{ secrets.RELEASE_SIGNING_KEY }}
```

Dispatch imports the private key inside the job, enables `tag.gpgsign`, and creates annotated signed tags.

## Verify A Release Tag

Import the public key and verify the tag:

```bash
gpg --import release-signing-key.asc
git fetch --tags
git verify-tag v1.2.3
```

## Clean Up Local Private Material

After the GitHub secret is configured, remove the exported private key file from the machine where you generated it:

```bash
shred -u release-signing-key.base64 signing-key.batch
```
