import { api } from './api'

declare const __IDLINUX_PLAYER_FONT__: string

const label = '↓ Download with ID Linux'
const manifests = new Set<string>()
;(window as Window & { idlinuxManifests?: Set<string> }).idlinuxManifests = manifests
const players = new Map<HTMLVideoElement, HTMLElement | null>()
let fallback: HTMLElement | null = null
let scheduled = false
let page = location.href
let playerFont: FontFace | undefined

function currentDocument(): void {
  if (page !== location.href) {
    manifests.clear()
    page = location.href
  }
}

function videoURL(video?: HTMLVideoElement): string {
  if (/(^|\.)youtube\.com$/.test(location.hostname) || location.hostname === 'youtu.be')
    return location.href
  const src =
    video?.currentSrc || video?.src || video?.querySelector<HTMLSourceElement>('source[src]')?.src
  if (src && /^https?:\/\//i.test(src)) return src
  return manifests.size === 1 && players.size <= 1 ? [...manifests][0] : location.href
}

function panel(video?: HTMLVideoElement): HTMLElement {
  const host = document.createElement('div')
  host.setAttribute('data-idlinux-video-panel', '')
  host.style.cssText =
    'all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.style.cssText =
    'font:700 14px/1.3 IDLinuxPlayer,system-ui,sans-serif;color:#ffffff;background:#7974ca;border:1px solid #31343b;border-radius:5px;padding:7px 12px;cursor:pointer;box-shadow:0 2px 8px #0005'
  button.addEventListener('click', async (event) => {
    if (!event.isTrusted) return
    event.preventDefault()
    event.stopPropagation()
    currentDocument()
    try {
      const opened = await api.runtime.sendMessage({ playerVideo: videoURL(video) })
      button.textContent = opened === true ? 'Opened in ID Linux' : 'Check ID Linux installation'
    } catch {
      button.textContent = 'Reload this page to reconnect'
    }
    schedule()
  })
  host.attachShadow({ mode: 'closed' }).append(button)
  if (!playerFont) {
    playerFont = new FontFace(
      'IDLinuxPlayer',
      Uint8Array.from(atob(__IDLINUX_PLAYER_FONT__), (character) => character.charCodeAt(0)),
      { weight: '100 700' }
    )
    void playerFont
      .load()
      .then((font) => {
        document.fonts.add(font)
        schedule()
      })
      .catch(() => {})
  }
  return host
}

function place(host: HTMLElement, parent: Element, right: number, top: number): void {
  if (host.parentNode !== parent) parent.append(host)
  const x = Math.max(2, Math.min(innerWidth, right) - host.offsetWidth - 6)
  host.style.setProperty('left', x + 'px', 'important')
  host.style.setProperty('top', Math.max(4, top + 6) + 'px', 'important')
}

function layout(): void {
  scheduled = false
  currentDocument()
  const fullscreen = document.fullscreenElement
  const parent = fullscreen || document.documentElement
  if (!parent) return
  for (const [video, existing] of players) {
    if (!video.isConnected) {
      existing?.remove()
      size.unobserve(video)
      intersection.unobserve(video)
      players.delete(video)
      continue
    }
    const rect = video.getBoundingClientRect()
    const width = Math.min(innerWidth, rect.right) - Math.max(0, rect.left)
    const height = Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)
    if (
      width < 150 ||
      height < 48 ||
      (video.checkVisibility
        ? !video.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
        : getComputedStyle(video).visibility !== 'visible') ||
      (fullscreen &&
        !(fullscreen === video || fullscreen.contains(video) || video.matches(':fullscreen *')))
    ) {
      existing?.remove()
      continue
    }
    const host = existing ?? panel(video)
    players.set(video, host)
    place(host, parent, rect.right, rect.top)
  }
  // A closed custom player may expose a playlist to the browser without exposing a video element.
  if (!players.size && manifests.size && innerWidth >= 150 && innerHeight >= 48) {
    fallback ??= panel()
    place(fallback, parent, innerWidth, 0)
  } else {
    fallback?.remove()
  }
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(layout)
}

const size = new ResizeObserver(schedule)
const intersection = new IntersectionObserver(schedule)
function discover(node: Element): void {
  if (node instanceof HTMLVideoElement && !players.has(node)) {
    players.set(node, null)
    size.observe(node)
    intersection.observe(node)
  }
  if (node.shadowRoot) watch(node.shadowRoot)
}

const roots = new WeakSet<Document | ShadowRoot>()
function scan(node: Element | Document | ShadowRoot): void {
  if (node instanceof Element) discover(node)
  for (const child of node.querySelectorAll('*')) discover(child)
}

function watch(root: Document | ShadowRoot): void {
  if (roots.has(root)) return
  roots.add(root)
  mutations.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'class', 'style']
  })
  scan(root)
}

const mutations = new MutationObserver((records) => {
  let changed = false
  for (const record of records) {
    if (record.target instanceof Element && record.target.hasAttribute('data-idlinux-video-panel'))
      continue
    if (record.type === 'attributes' && record.target instanceof Element) discover(record.target)
    for (const node of record.addedNodes) if (node instanceof Element) scan(node)
    changed = true
  }
  if (changed && (players.size || fallback || manifests.size)) schedule()
})

api.runtime.onMessage.addListener((message) => {
  if (message?.origin !== location.origin || typeof message.detectedManifest !== 'string') return
  currentDocument()
  if (manifests.size < 64 && /^https?:\/\//i.test(message.detectedManifest)) {
    manifests.add(message.detectedManifest)
    schedule()
  }
})
watch(document)
document.addEventListener(
  'pointerover',
  (event) => {
    for (const node of event.composedPath()) if (node instanceof Element) discover(node)
  },
  true
)
document.addEventListener('fullscreenchange', schedule)
document.addEventListener('scroll', schedule, { capture: true, passive: true })
window.addEventListener('resize', schedule)
