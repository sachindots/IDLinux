import { api } from './api'
import { BRIDGE_API, type BridgeAddRequest } from '../../src/shared/browserBridge'
import type { BrowserContext, BrowserCookie } from '../../src/shared/types'

export type Reach = 'ok' | 'closed' | 'update'

const HOST = 'org.idlinux.manager'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

async function call(
  op: 'ping' | 'add' | 'confirm',
  body?: unknown
): Promise<Record<string, unknown> | null> {
  const reply: unknown = await api.runtime.sendNativeMessage(HOST, { op, body }).catch(() => null)
  return object(reply) ? reply : null
}

export async function reach(): Promise<Reach> {
  const reply = await call('ping')
  if (reply?.status !== 200 || !object(reply.body) || reply.body.app !== 'idlinux') return 'closed'
  return reply.body.api === BRIDGE_API ? 'ok' : 'update'
}

export interface Handoff {
  token: string
}

export async function send(request: BridgeAddRequest): Promise<Handoff | 'kept' | 'closed'> {
  const reply = await call('add', request)
  if (!reply || reply.status === 503) return 'closed'
  if (reply.status !== 200 || !object(reply.body) || typeof reply.body.token !== 'string')
    return 'kept'
  return { token: reply.body.token }
}

export async function confirm({ token }: Handoff): Promise<boolean> {
  return (await call('confirm', { token }))?.status === 200
}

/** Firefox names its containers and private windows; Chrome's incognito store is "1". */
export function storeOf(source: {
  incognito: boolean
  cookieStoreId?: string
}): string | undefined {
  return source.cookieStoreId ?? (source.incognito ? '1' : undefined)
}

type IsolatedCookie = chrome.cookies.Cookie & { firstPartyDomain?: string }

function hostOf(url: string | undefined): string[] {
  try {
    return url ? [new URL(url).hostname] : []
  } catch {
    return []
  }
}

/** Cookies for where the download starts and where its redirects end; IDLinux sends each request
 * only the ones that match it. */
export async function browserContext(
  urls: readonly (string | undefined)[],
  storeId: string | undefined,
  referer: string | undefined
): Promise<BrowserContext> {
  const cookies = new Map<string, BrowserCookie>()
  const hosts = [...urls, referer].flatMap(hostOf)
  for (const url of new Set(urls)) {
    if (!url || !/^https?:/i.test(url)) continue
    const found = await api.cookies
      .getAll({ url, storeId })
      // Firefox with first-party isolation on refuses without firstPartyDomain. null reads every
      // site's copy, so only those kept for the download's own site or its page's are used.
      // Chrome refuses the key, so it's only tried second.
      .catch(async () => {
        const all = (await api.cookies.getAll({
          url,
          storeId,
          firstPartyDomain: null
        } as chrome.cookies.GetAllDetails)) as IsolatedCookie[]
        return all.filter(({ firstPartyDomain: site }) => {
          return !site || hosts.some((host) => host === site || host.endsWith(`.${site}`))
        })
      })
      .catch(() => [])
    for (const { name, value, domain, hostOnly, path, secure } of found) {
      cookies.set(`${domain}\n${path}\n${name}`, { name, value, domain, hostOnly, path, secure })
    }
  }
  return {
    cookies: [...cookies.values()],
    ...(referer && /^https?:/i.test(referer) && { referer }),
    userAgent: navigator.userAgent,
    name: browserName()
  }
}

function browserName(): string {
  const agent = navigator.userAgent
  if (/Firefox\//.test(agent)) return 'Firefox'
  if (/Edg\//.test(agent)) return 'Edge'
  if (/OPR\//.test(agent)) return 'Opera'
  if (/Vivaldi\//.test(agent)) return 'Vivaldi'
  if ('brave' in navigator) return 'Brave'
  return 'Chrome'
}

/** Only ever on a click: the browser asks the user whether to open the app. */
export async function wake(): Promise<boolean> {
  const tab = await api.tabs.create({ url: 'idlinux://open' })
  let reached = false
  for (let tries = 0; tries < 20 && !reached; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    reached = (await reach()) === 'ok'
  }
  if (reached && tab.id !== undefined) await api.tabs.remove(tab.id).catch(() => {})
  return reached
}
