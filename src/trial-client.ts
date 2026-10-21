/** The token belongs to this trial account, never to the public package. */
export async function trialRequest(baseUrl: string, method: string, route: string, body?: any): Promise<any> {
  let base: URL
  try {
    base = new URL(baseUrl)
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error()
  } catch { throw new Error('Trial: configure the provided HTTPS service origin in plugin settings') }
  const token = process.env.QUARTERMASTER_TRIAL_TOKEN
  if (!token) throw new Error('Trial: activation token is not configured on this server')
  try {
    const response = await fetch(new URL(route, base), {
      method, redirect: 'error', signal: AbortSignal.timeout(150000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    const data: any = await response.json()
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: 'invalid photographs or request', 401: 'activation token is invalid or revoked',
        402: 'allowance exhausted; manual equipment entry remains available',
        409: 'this identification is pending; retry the same intake later',
        429: 'service safety limit reached; contact OpenOceanOS',
        503: 'service temporarily unavailable; retry the same intake later'
      }
      throw new Error(`Trial: ${messages[response.status] || 'identification failed; retry the same intake later'}`)
    }
    if (!Number.isInteger(data.remaining) || data.remaining < 0 || data.limit !== 5) throw new Error('Trial: invalid service response')
    if (method === 'POST' && (!data.result || typeof data.model !== 'string')) throw new Error('Trial: incomplete service result')
    return data
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Trial:')) throw error
    throw new Error('Trial: service connection failed; retry this same intake to avoid a duplicate lookup')
  }
}
