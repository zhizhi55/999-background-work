import { sendWebPush } from './webPush.js'

const API_VERSION = '2026-06-13-request-handoff'
const MAX_RESULT_LENGTH = 2 * 1024 * 1024

function normalizeText(value, maxLength = 10000) {
  return String(value || '').trim().slice(0, maxLength)
}

function corsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '*'
  return new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  })
}

function json(data, status = 200, request = null) {
  const headers = corsHeaders(request)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { status, headers })
}

function bearerToken(request) {
  return normalizeText(request.headers.get('Authorization'), 4096).replace(/^Bearer\s+/i, '')
}

function timingSafeEqual(left, right) {
  const a = normalizeText(left, 4096)
  const b = normalizeText(right, 4096)
  if (!a || !b || a.length !== b.length) return false
  let result = 0
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return result === 0
}

function requireAuth(request, env) {
  const expected = normalizeText(env.ACCESS_TOKEN, 4096)
  return expected && timingSafeEqual(bearerToken(request), expected)
}

async function readBody(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function createJobId() {
  return `job_${Date.now()}_${crypto.randomUUID().replace(/-/g, '')}`
}

function normalizeSubscription(raw) {
  const endpoint = normalizeText(raw?.endpoint, 4096)
  const p256dh = normalizeText(raw?.keys?.p256dh || raw?.p256dh, 512)
  const auth = normalizeText(raw?.keys?.auth || raw?.auth, 512)
  if (!endpoint || !p256dh || !auth) return null
  try {
    if (new URL(endpoint).protocol !== 'https:') return null
  } catch {
    return null
  }
  return { endpoint, p256dh, auth }
}

function normalizeRequestHeaders(raw) {
  const headers = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return headers
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key || '').trim()
    if (!name || /^host$|^origin$|^referer$|^content-length$/i.test(name)) continue
    headers[name] = String(value ?? '')
  }
  return headers
}

function normalizeGenerationRequest(raw) {
  const url = normalizeText(raw?.request?.url, 4096)
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return null
  } catch {
    return null
  }
  const method = normalizeText(raw?.request?.method || 'POST', 16).toUpperCase()
  if (method !== 'POST') return null
  const body =
    typeof raw?.request?.body === 'string'
      ? raw.request.body.slice(0, 8 * 1024 * 1024)
      : JSON.stringify(raw?.request?.body ?? {})
  return {
    request: {
      url,
      method,
      headers: normalizeRequestHeaders(raw?.request?.headers),
      body,
    },
    context: {
      chatId: normalizeText(raw?.context?.chatId, 160),
      title: normalizeText(raw?.context?.title, 160) || 'AI 回复完成',
      targetUrl: normalizeText(raw?.context?.targetUrl, 1000) || '/',
      requestKey: normalizeText(raw?.context?.requestKey, 300),
    },
  }
}

async function sendPushToAll(env, payload) {
  const result = await env.BACKGROUND_DB.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions',
  ).all()
  const subscriptions = Array.isArray(result.results) ? result.results : []
  let successCount = 0
  for (const subscription of subscriptions) {
    try {
      await sendWebPush(subscription, payload, env)
      successCount += 1
      await env.BACKGROUND_DB.prepare(
        'UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE endpoint = ?',
      )
        .bind(Date.now(), subscription.endpoint)
        .run()
    } catch (error) {
      const status = Number(error?.status || 0)
      if (status === 404 || status === 410) {
        await env.BACKGROUND_DB.prepare(
          'DELETE FROM push_subscriptions WHERE endpoint = ?',
        )
          .bind(subscription.endpoint)
          .run()
      } else {
        await env.BACKGROUND_DB.prepare(
          'UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?',
        )
          .bind(normalizeText(error?.message, 500), subscription.endpoint)
          .run()
      }
    }
  }
  return successCount
}

async function processGenerationJob(message, env) {
  const jobId = normalizeText(message?.jobId, 200)
  const request = message?.request
  const context = message?.context || {}
  if (!jobId || !request?.url) throw new Error('任务数据不完整')
  await env.BACKGROUND_DB.prepare(
    `UPDATE generation_jobs
     SET status = 'running', started_at = ?, error_text = NULL
     WHERE id = ?`,
  )
    .bind(Date.now(), jobId)
    .run()
  try {
    const response = await fetch(request.url, {
      method: request.method || 'POST',
      headers: request.headers || {},
      body: request.body || '',
    })
    const responseText = (await response.text()).slice(0, MAX_RESULT_LENGTH)
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${responseText.slice(0, 2000)}`)
      error.retryable = response.status === 429 || response.status >= 500
      throw error
    }
    const completedAt = Date.now()
    await env.BACKGROUND_DB.prepare(
      `UPDATE generation_jobs
       SET status = 'completed', response_text = ?, response_status = ?,
           completed_at = ?, error_text = NULL
       WHERE id = ?`,
    )
      .bind(responseText, response.status, completedAt, jobId)
      .run()
    await sendPushToAll(env, {
      title: context.title || 'AI 回复完成',
      body: '回复已经生成，打开网页即可查看。',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `generation_${jobId}`,
      data: {
        url: context.targetUrl || '/',
        jobId,
        chatId: context.chatId || '',
      },
    })
  } catch (error) {
    await env.BACKGROUND_DB.prepare(
      `UPDATE generation_jobs
       SET status = 'failed', error_text = ?, completed_at = ?
       WHERE id = ?`,
    )
      .bind(normalizeText(error?.message, 4000), Date.now(), jobId)
      .run()
    throw error
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) })
  }
  if (request.method === 'GET' && url.pathname === '/v1/health') {
    return json(
      {
        ok: true,
        service: '999-background-worker',
        version: API_VERSION,
        capabilities: ['generation-handoff', 'web-push', 'queue'],
        vapidPublicKey: normalizeText(env.VAPID_PUBLIC_KEY, 512),
      },
      200,
      request,
    )
  }
  if (!requireAuth(request, env)) {
    return json({ ok: false, message: '访问令牌无效' }, 401, request)
  }

  if (request.method === 'GET' && url.pathname === '/v1/session') {
    return json({ ok: true }, 200, request)
  }

  if (request.method === 'POST' && url.pathname === '/v1/generation/jobs') {
    const payload = normalizeGenerationRequest(await readBody(request))
    if (!payload) return json({ ok: false, message: 'AI 请求数据无效' }, 400, request)
    if (payload.context.requestKey) {
      const existing = await env.BACKGROUND_DB.prepare(
        `SELECT id, status FROM generation_jobs
         WHERE request_key = ? AND status IN ('queued', 'running', 'completed')
         ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(payload.context.requestKey)
        .first()
      if (existing?.id) {
        return json({ ok: true, jobId: existing.id, status: existing.status }, 200, request)
      }
    }
    const jobId = createJobId()
    const createdAt = Date.now()
    await env.BACKGROUND_DB.prepare(
      `INSERT INTO generation_jobs
        (id, request_key, status, context_json, created_at)
       VALUES (?, ?, 'queued', ?, ?)`,
    )
      .bind(
        jobId,
        payload.context.requestKey || null,
        JSON.stringify(payload.context),
        createdAt,
      )
      .run()
    await env.GENERATION_QUEUE.send({
      jobId,
      request: payload.request,
      context: payload.context,
    })
    return json({ ok: true, jobId, status: 'queued' }, 202, request)
  }

  if (request.method === 'GET' && url.pathname.startsWith('/v1/generation/jobs/')) {
    const jobId = decodeURIComponent(url.pathname.slice('/v1/generation/jobs/'.length))
    const row = await env.BACKGROUND_DB.prepare(
      `SELECT id, request_key, status, context_json, response_text,
              response_status, error_text, created_at, started_at, completed_at
       FROM generation_jobs WHERE id = ?`,
    )
      .bind(jobId)
      .first()
    if (!row) return json({ ok: false, message: '任务不存在' }, 404, request)
    return json(
      {
        ok: true,
        job: {
          id: row.id,
          requestKey: row.request_key || '',
          status: row.status,
          context: JSON.parse(row.context_json || '{}'),
          responseText: row.status === 'completed' ? row.response_text || '' : '',
          responseStatus: Number(row.response_status || 0),
          error: row.status === 'failed' ? row.error_text || '任务失败' : '',
          createdAt: Number(row.created_at || 0),
          startedAt: Number(row.started_at || 0),
          completedAt: Number(row.completed_at || 0),
        },
      },
      200,
      request,
    )
  }

  if (request.method === 'DELETE' && url.pathname.startsWith('/v1/generation/jobs/')) {
    const jobId = decodeURIComponent(url.pathname.slice('/v1/generation/jobs/'.length))
    await env.BACKGROUND_DB.prepare('DELETE FROM generation_jobs WHERE id = ?')
      .bind(jobId)
      .run()
    return json({ ok: true }, 200, request)
  }

  if (request.method === 'POST' && url.pathname === '/v1/push/subscriptions') {
    const subscription = normalizeSubscription(await readBody(request))
    if (!subscription) {
      return json({ ok: false, message: 'PushSubscription 无效' }, 400, request)
    }
    const now = Date.now()
    await env.BACKGROUND_DB.prepare(
      `INSERT INTO push_subscriptions
        (endpoint, p256dh, auth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        updated_at = excluded.updated_at`,
    )
      .bind(subscription.endpoint, subscription.p256dh, subscription.auth, now, now)
      .run()
    return json({ ok: true }, 200, request)
  }

  if (request.method === 'DELETE' && url.pathname === '/v1/push/subscriptions') {
    const endpoint = normalizeText((await readBody(request))?.endpoint, 4096)
    if (endpoint) {
      await env.BACKGROUND_DB.prepare(
        'DELETE FROM push_subscriptions WHERE endpoint = ?',
      )
        .bind(endpoint)
        .run()
    }
    return json({ ok: true }, 200, request)
  }

  if (request.method === 'POST' && url.pathname === '/v1/push/test') {
    const count = await sendPushToAll(env, {
      title: '后台通知测试',
      body: '请求托管后台已经可以发送 Web Push。',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'background_test',
      data: { url: '/settings?tab=background' },
    })
    return json({ ok: true, delivered: count }, 200, request)
  }

  return json({ ok: false, message: '接口不存在' }, 404, request)
}

export default {
  fetch(request, env) {
    return handleRequest(request, env).catch((error) =>
      json(
        { ok: false, message: normalizeText(error?.message, 1000) || '服务器错误' },
        500,
        request,
      ),
    )
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processGenerationJob(message.body, env)
        message.ack()
      } catch (error) {
        console.error('generation job failed', error)
        if (error?.retryable === false) {
          message.ack()
        } else {
          message.retry()
        }
      }
    }
  },
}
