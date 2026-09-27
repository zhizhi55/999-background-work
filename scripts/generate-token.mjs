import { randomBytes } from 'node:crypto'

console.log(`ACCESS_TOKEN=bgt_${randomBytes(32).toString('base64url')}`)
