'use strict'

// Minimal GitHub REST client built on the global fetch (Node >= 20). It replaces the GitHub CLI for the three
// release operations this action performs (auth check, release lookup, release creation with asset upload).
//
// Why REST and not gh: gh resolves which token to send from its own host classification (github.com vs *.ghe.com vs
// GitHub Enterprise Server). That classification is the layer that rejected the automatic GITHUB_TOKEN on Enterprise
// with "HTTP 401: Must authenticate to access this API". Actions always exports GITHUB_API_URL pointing at the correct
// REST base for the active host, so we target it directly with an explicit `Authorization: Bearer <token>` header and
// avoid host guessing entirely.

const fs = require('node:fs')
const path = require('node:path')

const { branchNameFromRef, hasReleaseContext } = require('./release-context.js')

const ASSET_CONTENT_TYPE = 'application/octet-stream'

// apiBaseUrl returns the REST API base for the active GitHub host without a trailing slash.
// It fails closed when GITHUB_API_URL is missing rather than defaulting to api.github.com: every request carries the
// token in an Authorization header, and silently falling back to the public host would transmit an Enterprise token to
// github.com. Actions always exports GITHUB_API_URL for the active host, so the variable is only absent when the action
// runs outside its supported environment.
function apiBaseUrl() {
  const url = process.env['GITHUB_API_URL']
  if (!url) {
    throw new Error(
      'GITHUB_API_URL is not set; refusing to send the token to a default host. Run dispatch in GitHub Actions.',
    )
  }
  return url.replace(/\/+$/, '')
}

// repoPath splits "owner/name" and percent-encodes each segment for safe interpolation into a URL path.
function repoPath(repo) {
  const [owner, name, ...rest] = String(repo || '').split('/')
  if (!owner || !name || rest.length > 0) {
    throw new Error(`invalid repository ${JSON.stringify(repo)}; expected owner/name`)
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

// request issues an authenticated REST call. It returns { status, body } where body is parsed JSON when the response
// carries a JSON content type, otherwise the raw text. A non-2xx status throws unless it is listed in allowStatuses,
// so callers can treat an expected 404 (no release for a tag) as data rather than an error.
async function request(token, method, url, { body, headers, allowStatuses = [] } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...headers,
    },
    body,
  })
  const text = await res.text()
  let parsed = text
  if (text && (res.headers.get('content-type') || '').includes('application/json')) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  if (!res.ok && !allowStatuses.includes(res.status)) {
    const detail = parsed && parsed.message ? parsed.message : typeof parsed === 'string' ? parsed.trim() : ''
    throw new Error(`${method} ${url}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`)
  }
  return { status: res.status, body: parsed }
}

// makeLatestField maps the action's make-latest policy to the REST `make_latest` enum, returning null to omit the
// field. The decision mirrors the previous gh `--latest` flag handling:
//   true            -> mark as Latest
//   false           -> never Latest
//   auto            -> let GitHub decide by date/semver (REST "legacy")
//   default-branch  -> auto on the default branch, never Latest elsewhere
function makeLatestField(options = {}) {
  const makeLatest = options.makeLatest || 'default-branch'
  if (makeLatest === 'true') return 'true'
  if (makeLatest === 'false') return 'false'
  if (makeLatest === 'auto') return 'legacy'

  const context = options.releaseContext || {}
  if (!hasReleaseContext(context)) return 'legacy'

  const refName = context.refName || branchNameFromRef(context.ref || '')
  const defaultBranch = context.defaultBranch || ''
  if (defaultBranch && refName && refName === defaultBranch) return 'legacy'
  return 'false'
}

// uploadAsset uploads a single file to a release. assetPath must be absolute (callers resolve it against the workspace
// that validated it, so the read base matches the validation base). upload_url is an RFC 6570 template such as
// "https://uploads.<host>/.../assets{?name,label}"; GitHub returns it already pointing at the correct uploads host, so
// we only strip the template suffix and append the file name. The body is the raw file bytes.
async function uploadAsset(token, uploadUrl, assetPath) {
  const base = uploadUrl.replace(/\{[^}]*\}$/, '')
  const name = path.basename(assetPath)
  const data = fs.readFileSync(assetPath)
  await request(token, 'POST', `${base}?name=${encodeURIComponent(name)}`, {
    headers: { 'Content-Type': ASSET_CONTENT_TYPE },
    body: data,
  })
}

// createClient binds a token to the release operations. Methods take the repository as "owner/name" because the REST
// API has no remote-inference fallback the way gh did. The token is only validated when a method is actually called,
// so a create-release:false run (which performs no API calls) does not require one.
function createClient(token) {
  // checkAuth verifies the token can read the repository, failing fast before any tag is pushed.
  async function checkAuth(repo) {
    await request(token, 'GET', `${apiBaseUrl()}/repos/${repoPath(repo)}`)
  }

  // getReleaseByTag returns { exists, url, isDraft }. A 404 means no release is attached to the tag and must not be
  // confused with an auth or network failure, which would let the action recreate an existing release.
  async function getReleaseByTag(repo, tag) {
    const { status, body } = await request(
      token,
      'GET',
      `${apiBaseUrl()}/repos/${repoPath(repo)}/releases/tags/${encodeURIComponent(tag)}`,
      { allowStatuses: [404] },
    )
    if (status === 404) return { exists: false, url: '' }
    return { exists: true, url: body.html_url || '', isDraft: Boolean(body.draft) }
  }

  // createRelease creates the release for an already-pushed tag, uploads assets, and returns the release URL.
  // When assets are present the release is created as a draft, assets are uploaded, then it is published. This mirrors
  // the gh draft->upload->publish flow: with release immutability enabled, assets cannot be added after publish.
  async function createRelease(repo, tag, assets = [], options = {}) {
    const base = `${apiBaseUrl()}/repos/${repoPath(repo)}`
    const draft = assets.length > 0
    const payload = { tag_name: tag, draft, generate_release_notes: true }
    const latest = makeLatestField(options)
    if (latest) payload.make_latest = latest

    const created = await request(token, 'POST', `${base}/releases`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const release = created.body

    for (const asset of assets) {
      await uploadAsset(token, release.upload_url, asset)
    }

    if (draft) {
      const published = await request(token, 'PATCH', `${base}/releases/${release.id}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: false }),
      })
      return published.body.html_url || release.html_url || ''
    }
    return release.html_url || ''
  }

  return { checkAuth, getReleaseByTag, createRelease }
}

module.exports = {
  apiBaseUrl,
  createClient,
  makeLatestField,
  repoPath,
  request,
  uploadAsset,
}
