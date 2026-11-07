import { browserContext } from './idlinux'
import { api } from './api'

export interface VideoSource {
  url: string
  page: string
  label: string
}

// This function runs in the page's isolated world and must be self-contained.
export function findVideos(): VideoSource[] {
  const page = location.href
  if (!/^https?:\/\//i.test(page)) return []
  if (/(^|\.)youtube\.com$/.test(location.hostname) || location.hostname === 'youtu.be')
    return [{ url: page, page, label: 'YouTube · choose video quality' }]
  const found = new Map<string, VideoSource>()
  function add(value: string, kind: string): void {
    if (!/^https?:\/\//i.test(value) || found.size >= 64) return
    const url = new URL(value)
    const name = url.pathname.split('/').pop() || url.hostname
    found.set(value, { url: value, page, label: kind + ' · ' + name.slice(0, 70) })
  }
  for (const player of document.querySelectorAll('video, audio')) {
    if (!(player instanceof HTMLMediaElement)) continue
    add(player.currentSrc || player.src, 'Player')
    for (const source of player.querySelectorAll<HTMLSourceElement>('source[src]'))
      add(source.src, 'Source')
    if (!player.currentSrc || player.currentSrc.startsWith('blob:')) add(page, 'Player page')
  }
  const observed = (window as Window & { idlinuxManifests?: Set<string> }).idlinuxManifests
  for (const url of observed ?? []) add(url, 'Stream')
  for (const resource of performance.getEntriesByType('resource')) {
    if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(resource.name)) add(resource.name, 'Stream')
  }
  return [...found.values()]
}

export async function openVideo(source: VideoSource, storeId?: string): Promise<void> {
  const browser = await browserContext([source.url, source.page], storeId, source.page)
  const result: unknown = await api.runtime.sendNativeMessage('org.idlinux.manager', {
    op: 'video',
    body: { url: source.url, browser }
  })
  if (!result || typeof result !== 'object' || !('status' in result) || result.status !== 200)
    throw new Error(
      'Could not open the video window. Check that ID Linux 0.2 or later is installed.'
    )
}
