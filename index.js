import express from 'express'
import fetch from 'node-fetch'
import path from 'path'
import { newOctokit } from './octokit.js'

const MIME_TYPES = {
  '.txt': 'text/plain',
  '.py': 'text/x-python',
  '.tgz': 'application/gzip',
}

const router = express.Router()

function unbase64(input) {
  return Buffer.from(input, 'base64').toString('ascii')
}

class HttpError {
  constructor(code, message) {
    self.code = code
    self.message = message
  }
}

class BadRequest extends HttpError {
  constructor(message) {
    super(400, message)
  }
}

function httpErrorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.code).send(err.message)
  }
  next(err)
}

router.use(httpErrorHandler)

function bearer(req) {
  const header = req.get('Authorization')
  if (!header) {
    throw new BadRequest('Missing header: Authorization')
  }
  const m1 = header.match(/Bearer (.+)/)
  if (!m1) {
    throw new BadRequest('Malformed header: Authorization')
  }
  const userpass = unbase64(m1[1])
  const m2 = userpass.match(/([^:]+):(.+)/)
  if (!m2) {
    throw new BadRequest('Malformed header: Authorization')
  }
  const user = m2[1]
  const auth = m2[2]
  return { user, auth }
}

router.get('/v1/ping', (req, res) => {
  res
    .set('X-Conan-Server-Capabilities', 'complex_search,revisions')
    .send()
})

/**
 * Called during `conan user`.
 *
 * Return the Basic token right back to the Conan client.
 * Conan will pass whatever is returned as the Bearer token on future
 * requests.
 * That token is a base64 encoding of `user:ghtoken`.
 */
router.get('/:api/users/authenticate', (req, res) => {
  const header = req.get('Authorization')
  if (!header) {
    return res.status(400).send('Missing header: Authorization')
  }
  const match = header.match(/Basic (.+)/)
  if (!match) {
    return res.status(400).send('Malformed header: Authorization')
  }
  res.type('text/plain').send(match[1])
})

/**
 * Redirect to GitHub.
 *
 * Called during `conan install`.
 * Artifactory returns URLs of this form in the response to a `download_urls`
 * request, but we can just return GitHub URLs directly.
 *
 * Called during `conan upload` for `conanmanifest.txt`.
 * If it returns 404, then Conan proceeds to call `check_credentials` and then
 * `files`.
 */
router.get('/:api/conans/:package/:version/:host/:owner/revisions/:revision/files/:filename', (req, res) => {
  const repo = req.params.package
  const tag = req.params.version
  const host = req.params.host
  const owner = req.params.owner
  const ref = `${repo}/${tag}@${host}/${owner}`

  if (host !== 'github') {
    return res.status(403).send(`Not a GitHub package: '${ref}'`)
  }

  const filename = req.params.filename
  return res.redirect(301, `https://github.com/${owner}/${repo}/releases/download/${tag}/${filename}`)
})

/**
 * Called during `conan upload`.
 */
router.get('/:api/users/check_credentials', async (req, res) => {
  const { user, auth } = bearer(req)
  const client = req.get('X-Client-Id')
  if (user !== client) {
    console.warn(`Bearer token (${user}) does not match X-Client-Id (${client})`)
  }
  const octokit = newOctokit({ auth })
  const response = await octokit.rest.users.getAuthenticated()
  if (response.status !== 200) {
    return res.status(401).send('Invalid GitHub token')
  }
  const login = response.data.login
  if (login !== user) {
    console.warn(`Bearer token (${user}) does not match GitHub token (${login})`)
  }
  return res.send(user)
})

/**
 * Called during `conan upload`.
 * If it returns 404, then Conan uploads assets.
 * If it returns 200, then the package exists.
 */
router.get('/:api/conans/:package/:version/:host/:owner/revisions/:revision/files', async (req, res) => {
  const repo = req.params.package
  const tag = req.params.version
  const host = req.params.host
  const owner = req.params.owner
  const ref = `${repo}/${tag}@${host}/${owner}`

  if (host !== 'github') {
    return res.status(403).send(`Not a GitHub package: '${ref}'`)
  }

  const { user, auth } = bearer(req)
  const octokit = newOctokit({ auth })
  const response = await octokit.rest.repos.getReleaseByTag({
    owner,
    repo,
    tag
  })
  if (response.status !== 200) {
    return res.status(404).send(`Recipe not found: ${ref}`)
  }

  const files = {}
  for (const asset of response.data.assets) {
    files[asset.name] = {}
  }
  return res.send({ files })
})

/** This may be impossible to implement. */
router.get('/:api/conans/search', (req, res) => {
  const query = req.query.q
  // TODO: Let projects tag themselves #redirectory.
  // Search among tagged projects for package names,
  // then collect their releases.
  return res.status(501).send()
})

/**
 * Called as the first step of `conan install`.
 */
router.get('/:api/conans/:package/:version/:host/:owner/download_urls', (req, res) => {
  const repo = req.params.package
  const tag = req.params.version
  const host = req.params.host
  const owner = req.params.owner
  const ref = `${repo}/${tag}@${host}/${owner}`

  if (host !== 'github') {
    return res.status(403).send(`Not a GitHub package: '${ref}'`)
  }

  // TODO: Check if the release exists.
  const found = true
  if (!found) {
    return res.status(404).send(`Recipe not found: '${ref}'`)
  }

  const data = {}
  const filenames = ['conanmanifest.txt', 'conanfile.py', 'conan_export.tgz', 'conan_sources.tgz']
  for (const filename of filenames) {
    data[filename] = `https://github.com/${owner}/${repo}/releases/download/${tag}/${filename}`
  }
  return res.send(data)
})

router.get('/:api/conans/:package/:version/:host/:owner/packages/:binaryId/download_urls', (req, res) => {
  // TODO: Implement binary uploads.
  return res.status(404).send()
})

/**
 * Called during `conan install`.
 */
router.get('/:api/conans/:package/:version/:host/:owner/revisions/:revision/packages/:binaryId/latest', (req, res) => {
  // TODO: Implement binary downloads.
  return res.status(404).send()
})

/**
 * Called during `conan install`.
 */
router.get('/:api/conans/:package/:version/:host/:owner/latest', (req, res) => {
  return res.send({revision: '0', time: new Date().toISOString()})
})

/**
 * Called during `conan upload`.
 */
router.put('/:api/conans/:package/:version/:host/:owner/revisions/:revision/files/:filename', async (req, res) => {
  const repo = req.params.package
  const tag = req.params.version
  const host = req.params.host
  const owner = req.params.owner
  const ref = `${repo}/${tag}@${host}/${owner}`

  if (host !== 'github') {
    return res.status(403).send(`Not a GitHub package: '${ref}'`)
  }

  const { user, auth } = bearer(req)
  const octokit = newOctokit({ auth })

  let response = await octokit.rest.repos.getReleaseByTag({
    owner,
    repo,
    tag,
  })
  if (response.status !== 200) {
    response = await octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag_name: `v${tag}`,
    })
  }
  if (response.status !== 200) {
    return res.status(403).send(`Cannot find release: '${ref}'`)
  }
  const release_id = response.data.id
  const origin = new URL(response.data.upload_url).origin

  const filename = req.params.filename
  const extension = path.extname(filename)
  const mimeType = MIME_TYPES[extension] || 'application/octet-stream'

  response = await fetch(`${origin}/repos/${owner}/${repo}/releases/${release_id}/assets?name=${filename}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${auth}`,
      'Content-Type': mimeType,
      'Content-Length': req.get('Content-Length'),
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: req,
  })
  if (response.status !== 200) {
    return res.status(response.status).send()
  }

  return res.send()
})

/**
 * Called during `conan remove`.
 */
router.get('/:api/conans/:package/:version/:host/:owner/revisions', (req, res) => {
  const repo = req.params.package
  const tag = req.params.version
  const host = req.params.host
  const owner = req.params.owner
  const ref = `${repo}/${tag}@${host}/${owner}`

  if (host !== 'github') {
    return res.status(403).send(`Not a GitHub package: '${ref}'`)
  }

  return res.send({revisions: [{revision: '0', time: new Date().toISOString()}]})
})

/**
 * Called during `conan remove`.
 */
router.delete('/:api/conans/:package/:version/:host/:owner/revisions/:revision', async (req, res) => {
  const repo = req.params.package
  const tag = req.params.version
  const host = req.params.host
  const owner = req.params.owner
  const ref = `${repo}/${tag}@${host}/${owner}`

  if (host !== 'github') {
    return res.status(403).send(`Not a GitHub package: '${ref}'`)
  }

  const { user, auth } = bearer(req)
  const octokit = newOctokit({ auth })

  let response = await octokit.rest.repos.getReleaseByTag({
    owner,
    repo,
    tag
  })
  if (response.status !== 200) {
    return res.status(403).send(`Cannot find release: '${ref}'`)
  }

  for (const asset of response.data.assets) {
    await octokit.rest.repos.deleteReleaseAsset({
      owner,
      repo,
      asset_id: asset.id
    })
  }

  return res.send()
})

router.all('*', (req, res) => {
  console.log(req.method, req.originalUrl)
  res.status(501).send()
})

export default router
