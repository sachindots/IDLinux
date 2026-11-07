import { api } from './api'
import { findVideos, openVideo } from './video'
import { reach, storeOf } from './idlinux'
import { excluded, loadSettings, saveSettings } from './settings'

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const ALL_SITES = { origins: ['<all_urls>'] }

async function activeHost(): Promise<string | null> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  return tab?.url && /^https?:/i.test(tab.url) ? new URL(tab.url).hostname : null
}

async function render(): Promise<void> {
  const [settings, host, reached, access] = await Promise.all([
    loadSettings(),
    activeHost(),
    reach(),
    // Firefox lets the user withhold site access, which reading a site's cookies needs.
    api.permissions.contains(ALL_SITES)
  ])
  const [tone, text] =
    reached === 'closed'
      ? ['', 'ID Linux not open']
      : reached === 'update'
        ? ['warn', 'Update ID Linux']
        : settings.capture
          ? ['ok', 'Connected']
          : ['', 'Capture off']
  element('status-dot').className = `dot ${tone}`
  element('status-text').textContent = text
  element('access').hidden = access
  element('closed').hidden = reached !== 'closed'

  element<HTMLInputElement>('capture').checked = settings.capture
  element('capture-hint').textContent = settings.capture
    ? 'Downloads open in ID Linux instead of the browser.'
    : 'Downloads stay in the browser.'

  element('site-row').hidden = host === null
  if (host) {
    const on = !excluded(settings.sites, [`https://${host}/`])
    const site = element<HTMLInputElement>('site')
    site.checked = on && settings.capture
    site.disabled = !settings.capture
    element('site-host').textContent = host
    element('site-hint').textContent = !settings.capture
      ? 'Capture is off everywhere.'
      : on
        ? 'Downloads from this site go to ID Linux.'
        : 'Downloads from this site stay in the browser.'
  }
}

element<HTMLInputElement>('capture').addEventListener('change', (event) => {
  void saveSettings({ capture: (event.target as HTMLInputElement).checked })
})

element<HTMLInputElement>('site').addEventListener('change', async (event) => {
  const host = await activeHost()
  if (!host) return
  const { sites } = await loadSettings()
  // A parent domain's rule covers this site too, so turning it back on drops that as well.
  const covering = (site: string): boolean => host === site || host.endsWith(`.${site}`)
  await saveSettings({
    sites: (event.target as HTMLInputElement).checked
      ? sites.filter((site) => !covering(site))
      : [...sites, host]
  })
})

element('grant').addEventListener('click', () => {
  void api.permissions.request(ALL_SITES).then(render)
})
element('open-idlinux').addEventListener('click', () => {
  void api.runtime.sendMessage({ wakeIDLinux: true })
})
element('options').addEventListener('click', () => void api.runtime.openOptionsPage())

api.storage.onChanged.addListener(() => void render())
void render()
// So the toolbar icon agrees with the popup now, not at its next check.
void api.runtime.sendMessage({ checkIDLinux: true }).catch(() => {})

async function showVideos(): Promise<void> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined || !tab.url || !/^https?:\/\//i.test(tab.url)) return
  const frames = await api.scripting
    .executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: findVideos
    })
    .catch(() => [])
  const sources = new Map(
    frames.flatMap((frame) => (frame.result ?? []).map((source) => [source.url, source] as const))
  )
  if (!sources.has(tab.url))
    sources.set(tab.url, { url: tab.url, page: tab.url, label: 'Find video on this page' })
  const select = element<HTMLSelectElement>('video-source')
  const videos = [...sources.values()]
  videos.forEach((source, i) => select.add(new Option(source.label, String(i))))
  element('videos').hidden = false
  select.addEventListener('change', () => {
    element('video-fallback').hidden = true
  })
  const button = element<HTMLButtonElement>('download-video')
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      await openVideo(videos[select.selectedIndex], storeOf(tab))
      element('video-result').textContent = 'Opened in ID Linux'
    } catch {
      element('video-result').textContent = 'Native host unavailable.'
      const fallback = element<HTMLAnchorElement>('video-fallback')
      fallback.href =
        'idlinux-video://open?url=' + encodeURIComponent(videos[select.selectedIndex].url)
      fallback.hidden = false
    } finally {
      button.disabled = false
    }
  })
}
void showVideos()
