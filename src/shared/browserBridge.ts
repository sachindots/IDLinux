import type { BrowserContext } from './types'

// The extension imports this file too, so IDLinux and the extension can't drift apart.

/** Raised when an older extension or IDLinux couldn't follow a change to /ping or /add. */
export const BRIDGE_API = 1
/** The extension waits a little longer than this, and IDLinux adds nothing once it has given up,
 * so a download never ends up in both. */
export const BRIDGE_DEADLINE_MS = 8000

export interface BridgePing {
  app: 'idlinux'
  version: string
  api: number
}

/** 200 with a BridgeHandoff: IDLinux will take it. 422: the browser keeps it. Never held past the
 * deadline: Chrome stops an extension's service worker when a fetch takes over 30 s. */
export interface BridgeAddRequest {
  url: string
  browser?: BrowserContext
  pageUrl?: string
  minBytes?: number
  /** The name the browser picked: only it saw a link's download attribute. */
  fileName?: string
}

/** IDLinux shows the download only once POST /confirm brings this back: the extension confirms
 * after the browser's copy is really gone, since it can finish before it's cancelled. Unconfirmed,
 * it expires and IDLinux shows nothing, so a download never ends up in both. */
export interface BridgeHandoff {
  token: string
}
