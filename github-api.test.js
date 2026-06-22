'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { apiBaseUrl, createClient, makeLatestField, repoPath, request, retryDelayMs } = require('./github-api.js')

const noSleep = () => Promise.resolve()

// fakeResponse mimics the subset of the fetch Response interface that github-api.js consumes.
function fakeResponse({ status = 200, body = '', json = true } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' && json ? 'application/json' : null) },
    text: () => Promise.resolve(text),
  }
}

// withFetch installs a stub global.fetch that records calls and answers from handler(url, options).
function withFetch(handler, fn) {
  const previous = global.fetch
  const calls = []
  global.fetch = (url, options = {}) => {
    calls.push({ url, options })
    return Promise.resolve(handler(url, options, calls.length - 1))
  }
  return Promise.resolve(fn(calls)).finally(() => {
    global.fetch = previous
  })
}

function withApiUrl(value, fn) {
  const previous = process.env['GITHUB_API_URL']
  if (value === undefined) delete process.env['GITHUB_API_URL']
  else process.env['GITHUB_API_URL'] = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env['GITHUB_API_URL']
    else process.env['GITHUB_API_URL'] = previous
  }
}

test('apiBaseUrl trims trailing slashes for the active host', () => {
  withApiUrl('https://api.github.com', () => assert.equal(apiBaseUrl(), 'https://api.github.com'))
  withApiUrl('https://ghe.example.com/api/v3/', () => assert.equal(apiBaseUrl(), 'https://ghe.example.com/api/v3'))
})

test('apiBaseUrl fails closed when GITHUB_API_URL is unset instead of leaking the token to a default host', () => {
  withApiUrl(undefined, () => assert.throws(() => apiBaseUrl(), /GITHUB_API_URL is not set/))
})

test('an authenticated call refuses to run when GITHUB_API_URL is unset', async () => {
  let fetched = false
  const previous = global.fetch
  global.fetch = () => {
    fetched = true
    return Promise.resolve(fakeResponse({ status: 200, body: {} }))
  }
  try {
    await withApiUrl(undefined, () =>
      assert.rejects(createClient('secret-token').checkAuth('owner/name'), /GITHUB_API_URL is not set/),
    )
  } finally {
    global.fetch = previous
  }
  assert.equal(fetched, false, 'no request must be made without a known API host')
})

test('repoPath splits and encodes owner/name', () => {
  assert.equal(repoPath('owner/name'), 'owner/name')
  assert.equal(repoPath('o w/n a'), 'o%20w/n%20a')
})

test('repoPath rejects malformed repositories', () => {
  assert.throws(() => repoPath('owner'), /invalid repository/)
  assert.throws(() => repoPath('a/b/c'), /invalid repository/)
  assert.throws(() => repoPath(''), /invalid repository/)
})

test('makeLatestField maps the make-latest policy to the REST enum', () => {
  assert.equal(makeLatestField({ makeLatest: 'true' }), 'true')
  assert.equal(makeLatestField({ makeLatest: 'false' }), 'false')
  assert.equal(makeLatestField({ makeLatest: 'auto' }), 'legacy')
  assert.equal(makeLatestField({}), 'legacy')
})

test('makeLatestField keeps non-default branch releases out of Latest under default-branch', () => {
  const onDefault = { makeLatest: 'default-branch', releaseContext: { refName: 'main', defaultBranch: 'main' } }
  const offDefault = { makeLatest: 'default-branch', releaseContext: { refName: 'feature', defaultBranch: 'main' } }
  assert.equal(makeLatestField(onDefault), 'legacy')
  assert.equal(makeLatestField(offDefault), 'false')
})

test('checkAuth GETs the repository with a bearer header and throws on failure', async () => {
  await withApiUrl('https://api.github.com', () =>
    withFetch(
      () => fakeResponse({ status: 200, body: { full_name: 'owner/name' } }),
      async (calls) => {
        await createClient('secret').checkAuth('owner/name')
        assert.equal(calls[0].url, 'https://api.github.com/repos/owner/name')
        assert.equal(calls[0].options.method, 'GET')
        assert.equal(calls[0].options.headers.Authorization, 'Bearer secret')
      },
    ),
  )

  await withApiUrl('https://api.github.com', () =>
    withFetch(
      () => fakeResponse({ status: 401, body: { message: 'Must authenticate to access this API.' } }),
      async () => {
        await assert.rejects(createClient('super-secret-token').checkAuth('owner/name'), (err) => {
          assert.match(err.message, /HTTP 401.*Must authenticate/)
          // The raw token must never appear in an error surfaced to logs or the step summary.
          assert.equal(err.message.includes('super-secret-token'), false, 'token leaked into the error message')
          return true
        })
      },
    ),
  )
})

test('getReleaseByTag returns the release on 200 and absence on 404', async () => {
  await withApiUrl('https://api.github.com', () =>
    withFetch(
      () => fakeResponse({ status: 200, body: { html_url: 'https://x/releases/v1', draft: false } }),
      async () => {
        const res = await createClient('secret').getReleaseByTag('owner/name', 'v1.2.3')
        assert.deepEqual(res, { exists: true, url: 'https://x/releases/v1', isDraft: false })
      },
    ),
  )

  await withApiUrl('https://api.github.com', () =>
    withFetch(
      () => fakeResponse({ status: 404, body: { message: 'Not Found' } }),
      async (calls) => {
        const res = await createClient('secret').getReleaseByTag('owner/name', 'v1.2.3')
        assert.deepEqual(res, { exists: false, url: '' })
        assert.equal(calls[0].url, 'https://api.github.com/repos/owner/name/releases/tags/v1.2.3')
      },
    ),
  )
})

test('getReleaseByTag does not swallow non-404 failures', async () => {
  await withApiUrl('https://api.github.com', () =>
    withFetch(
      () => fakeResponse({ status: 403, body: { message: 'Forbidden' } }),
      async () => {
        await assert.rejects(
          createClient('secret', { sleep: noSleep }).getReleaseByTag('owner/name', 'v1.2.3'),
          /HTTP 403/,
        )
      },
    ),
  )
})

test('createRelease without assets publishes directly and returns the URL', async () => {
  await withApiUrl('https://api.github.com', () =>
    withFetch(
      () => fakeResponse({ status: 201, body: { id: 7, html_url: 'https://x/releases/v1', upload_url: '' } }),
      async (calls) => {
        const url = await createClient('secret').createRelease('owner/name', 'v1.2.3', [], {
          makeLatest: 'true',
        })
        assert.equal(url, 'https://x/releases/v1')
        assert.equal(calls.length, 1)
        assert.equal(calls[0].options.method, 'POST')
        const payload = JSON.parse(calls[0].options.body)
        assert.equal(payload.tag_name, 'v1.2.3')
        assert.equal(payload.draft, false)
        assert.equal(payload.generate_release_notes, true)
        assert.equal(payload.make_latest, 'true')
      },
    ),
  )
})

test('createRelease with assets drafts, uploads, then publishes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-api-'))
  const assetPath = path.join(dir, 'artifact.bin')
  fs.writeFileSync(assetPath, 'payload-bytes')

  try {
    await withApiUrl('https://api.github.com', () =>
      withFetch(
        (url, options) => {
          if (options.method === 'POST' && url.endsWith('/releases')) {
            return fakeResponse({
              status: 201,
              body: {
                id: 9,
                html_url: '',
                upload_url: 'https://uploads.example/repos/o/n/releases/9/assets{?name,label}',
              },
            })
          }
          if (options.method === 'POST') {
            return fakeResponse({ status: 201, body: { id: 1 } })
          }
          return fakeResponse({ status: 200, body: { html_url: 'https://x/releases/v1' } })
        },
        async (calls) => {
          const url = await createClient('secret').createRelease('owner/name', 'v1.2.3', [assetPath], {})
          assert.equal(url, 'https://x/releases/v1')

          assert.equal(JSON.parse(calls[0].options.body).draft, true)

          const upload = calls[1]
          assert.equal(upload.url, 'https://uploads.example/repos/o/n/releases/9/assets?name=artifact.bin')
          assert.equal(upload.options.headers['Content-Type'], 'application/octet-stream')

          const publish = calls[2]
          assert.equal(publish.options.method, 'PATCH')
          assert.equal(publish.url, 'https://api.github.com/repos/owner/name/releases/9')
          assert.equal(JSON.parse(publish.options.body).draft, false)
        },
      ),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Transient-failure hardening

test('request sends an identifying User-Agent, which GitHub requires', async () => {
  await withFetch(
    () => fakeResponse({ status: 200, body: {} }),
    async (calls) => {
      await request('tok', 'GET', 'https://api.example/x')
      assert.equal(calls[0].options.headers['User-Agent'], 'goeselt-dispatch')
    },
  )
})

test('request retries a retryable status and then succeeds', async () => {
  await withFetch(
    (url, options, i) => (i < 2 ? fakeResponse({ status: 503 }) : fakeResponse({ status: 200, body: { ok: true } })),
    async (calls) => {
      const res = await request('tok', 'GET', 'https://api.example/x', { sleep: noSleep })
      assert.deepEqual(res.body, { ok: true })
      assert.equal(calls.length, 3)
    },
  )
})

test('request stops after maxAttempts and surfaces the last failure', async () => {
  await withFetch(
    () => fakeResponse({ status: 500, body: { message: 'boom' } }),
    async (calls) => {
      await assert.rejects(request('tok', 'GET', 'https://api.example/x', { sleep: noSleep }), /HTTP 500 boom/)
      assert.equal(calls.length, 4)
    },
  )
})

test('request retries an idempotent method after a network error', async () => {
  await withFetch(
    (url, options, i) => {
      if (i === 0) throw new Error('ECONNRESET')
      return fakeResponse({ status: 200, body: { ok: true } })
    },
    async (calls) => {
      const res = await request('tok', 'GET', 'https://api.example/x', { sleep: noSleep })
      assert.deepEqual(res.body, { ok: true })
      assert.equal(calls.length, 2)
    },
  )
})

test('request does not retry a POST after a network error, to avoid duplicate writes', async () => {
  await withFetch(
    () => {
      throw new Error('ECONNRESET')
    },
    async (calls) => {
      await assert.rejects(request('tok', 'POST', 'https://api.example/x', { sleep: noSleep }), /ECONNRESET/)
      assert.equal(calls.length, 1)
    },
  )
})

test('request honors a Retry-After header as the minimum backoff and retries a 403 secondary-rate limit', async () => {
  const delays = []
  const recordingSleep = (ms) => {
    delays.push(ms)
    return Promise.resolve()
  }
  await withFetch(
    (url, options, i) =>
      i === 0
        ? {
            ok: false,
            status: 403,
            headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '7' : null) },
            text: () => Promise.resolve(''),
          }
        : fakeResponse({ status: 200, body: { ok: true } }),
    async (calls) => {
      const res = await request('tok', 'GET', 'https://api.example/x', { sleep: recordingSleep })
      assert.deepEqual(res.body, { ok: true })
      assert.equal(calls.length, 2)
      assert.ok(delays[0] >= 7000, `expected the Retry-After floor of 7000ms, got ${delays[0]}`)
    },
  )
})

test('request does not retry a plain 403 without Retry-After', async () => {
  await withFetch(
    () => fakeResponse({ status: 403, body: { message: 'Forbidden' } }),
    async (calls) => {
      await assert.rejects(request('tok', 'GET', 'https://api.example/x', { sleep: noSleep }), /HTTP 403/)
      assert.equal(calls.length, 1)
    },
  )
})

test('retryDelayMs grows with attempts and respects the Retry-After floor', () => {
  assert.ok(retryDelayMs(1, null) >= 500)
  assert.ok(retryDelayMs(3, null) >= retryDelayMs(1, null))
  assert.ok(retryDelayMs(1, '30') >= 30000)
})

test('request reports each retry through onRetry with the status and attempt', async () => {
  const events = []
  await withFetch(
    (url, options, i) => (i === 0 ? fakeResponse({ status: 503 }) : fakeResponse({ status: 200, body: { ok: true } })),
    async () => {
      await request('tok', 'GET', 'https://api.example/x', { sleep: noSleep, onRetry: (info) => events.push(info) })
    },
  )
  assert.equal(events.length, 1)
  assert.deepEqual(
    {
      method: events[0].method,
      status: events[0].status,
      attempt: events[0].attempt,
      maxAttempts: events[0].maxAttempts,
    },
    { method: 'GET', status: 503, attempt: 1, maxAttempts: 4 },
  )
  assert.ok(events[0].delayMs >= 500)
})

test('onRetry reports a null status for a network-level retry', async () => {
  const events = []
  await withFetch(
    (url, options, i) => {
      if (i === 0) throw new Error('ECONNRESET')
      return fakeResponse({ status: 200, body: {} })
    },
    async () => {
      await request('tok', 'GET', 'https://api.example/x', { sleep: noSleep, onRetry: (info) => events.push(info) })
    },
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].status, null)
})
