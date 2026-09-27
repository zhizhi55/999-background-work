const encoder = new TextEncoder()

function fromBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function toBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function concatBytes(...parts) {
  const chunks = parts.map((part) =>
    part instanceof Uint8Array ? part : new Uint8Array(part),
  )
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => {
    result.set(chunk, offset)
    offset += chunk.byteLength
  })
  return result
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
    },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

function uint32(value) {
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value)
  return result
}

function vapidJwk(publicKey, privateKey) {
  const publicBytes = fromBase64Url(publicKey)
  const privateBytes = fromBase64Url(privateKey)
  if (publicBytes.byteLength !== 65 || publicBytes[0] !== 4) {
    throw new Error('VAPID_PUBLIC_KEY 必须是 65 字节未压缩 P-256 公钥')
  }
  if (privateBytes.byteLength !== 32) {
    throw new Error('VAPID_PRIVATE_KEY 必须是 32 字节 P-256 私钥')
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64Url(publicBytes.slice(1, 33)),
    y: toBase64Url(publicBytes.slice(33, 65)),
    d: toBase64Url(privateBytes),
    ext: true,
  }
}

async function createVapidAuthorization(endpoint, env) {
  const audience = new URL(endpoint).origin
  const now = Math.floor(Date.now() / 1000)
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        exp: now + 12 * 60 * 60,
        sub: String(env.VAPID_SUBJECT || '').trim(),
      }),
    ),
  )
  const unsigned = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    'jwk',
    vapidJwk(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(unsigned),
  )
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${env.VAPID_PUBLIC_KEY}`
}

async function encryptPayload(subscription, payload) {
  const clientPublic = fromBase64Url(subscription.p256dh)
  const authSecret = fromBase64Url(subscription.auth)
  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const serverPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey },
    serverPair.privateKey,
    256,
  )
  const serverPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverPair.publicKey),
  )
  const keyInfo = concatBytes(
    encoder.encode('WebPush: info\0'),
    clientPublic,
    serverPublic,
  )
  const ikm = await hkdf(authSecret, new Uint8Array(sharedBits), keyInfo, 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const contentKey = await hkdf(
    salt,
    ikm,
    encoder.encode('Content-Encoding: aes128gcm\0'),
    16,
  )
  const nonce = await hkdf(
    salt,
    ikm,
    encoder.encode('Content-Encoding: nonce\0'),
    12,
  )
  const plaintext = concatBytes(encoder.encode(JSON.stringify(payload)), new Uint8Array([2]))
  const aesKey = await crypto.subtle.importKey(
    'raw',
    contentKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext),
  )
  const recordSize = plaintext.byteLength + 16
  return concatBytes(
    salt,
    uint32(recordSize),
    new Uint8Array([serverPublic.byteLength]),
    serverPublic,
    ciphertext,
  )
}

export async function sendWebPush(subscription, payload, env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error('VAPID 配置不完整')
  }
  const body = await encryptPayload(subscription, payload)
  const authorization = await createVapidAuthorization(subscription.endpoint, env)
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  })
  if (!response.ok) {
    const error = new Error(`Push 服务返回 ${response.status}`)
    error.status = response.status
    throw error
  }
}
