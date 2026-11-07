import { chromium } from '@playwright/test'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BLOCK, expect, PROJECT_ROOT, test } from './fixtures'
import { sha256 } from './origin'

test('Chromium hands a real download to the Linux desktop through its native host', async ({
  dirs,
  idlinux,
  serve
}) => {
  const executablePath = process.env.IDLINUX_TEST_BROWSER
  test.skip(!executablePath, 'set IDLINUX_TEST_BROWSER to a Chromium or Brave executable')
  await idlinux.api.updateSettings({ destinationDir: dirs.dest })
  await idlinux.page.reload()
  const root = dirname(dirs.userData)
  const profile = join(root, 'browser')
  const product = executablePath?.includes('brave') ? 'BraveSoftware/Brave-Browser' : 'chromium'
  const hosts = join(root, product, 'NativeMessagingHosts')
  await mkdir(hosts, { recursive: true })
  await symlink(dirs.userData, join(root, 'idlinux'))
  const manifest = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'integration/chromium.json'), 'utf8')
  )
  manifest.path = join(PROJECT_ROOT, 'integration/native_host.py')
  await writeFile(join(hosts, manifest.name + '.json'), JSON.stringify(manifest))
  await mkdir(join(profile, 'Default'), { recursive: true })
  await writeFile(
    join(profile, 'Default/Preferences'),
    JSON.stringify({
      download: { default_directory: join(root, 'browser-files'), prompt_for_download: false }
    })
  )
  const extension = join(PROJECT_ROOT, 'extension/dist/chrome')
  const browser = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`],
    env: { ...process.env, XDG_CONFIG_HOME: root }
  })
  try {
    const origin = await serve({
      size: 16 * BLOCK,
      bytesPerSecond: 256 * 1024,
      contentDisposition: 'attachment; filename="browser-transfer.bin"'
    })
    const popup = await browser.newPage()
    await popup.goto(manifest.allowed_origins[0] + 'popup.html')
    await expect(popup.getByText('Connected', { exact: true })).toBeVisible()
    const page = await browser.newPage()
    await test.step('popup finds a manifest with no URL extension on a custom player page', async () => {
      const media = createServer((req, res) => {
        if (req.url === '/playback') {
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
          res.end('#EXTM3U')
        } else {
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Security-Policy': "font-src 'none'"
          })
          res.end('<title>Video fixture</title><video width="320" height="180"></video>')
        }
      })
      await new Promise<void>((resolve) => media.listen(0, '127.0.0.1', resolve))
      try {
        await page.goto('http://127.0.0.1:' + (media.address() as AddressInfo).port)
        await page.bringToFront()
        const panel = page.locator('[data-idlinux-video-panel]')
        await expect(panel).toBeVisible()
        await expect
          .poll(() =>
            page.evaluate(() =>
              Array.from(document.fonts as unknown as Iterable<FontFace>).some(
                (font) => font.family === 'IDLinuxPlayer' && font.status === 'loaded'
              )
            )
          )
          .toBe(true)
        await page.mouse.move(600, 400)
        await expect(panel).toBeVisible()
        await page.evaluate(() => {
          const player = document.createElement('section')
          player.attachShadow({ mode: 'open' }).innerHTML =
            '<video width="320" height="180"></video>'
          document.body.append(player)
        })
        await expect(panel).toHaveCount(2)
        await page.evaluate(() =>
          document.querySelectorAll('body > video, body > section').forEach((el) => el.remove())
        )
        await expect(panel).toHaveCount(0)
        await page.evaluate(async () => (await fetch('/playback')).text())
        await expect(panel).toBeVisible()
        const corner = await panel.boundingBox()
        expect(corner!.y).toBeLessThan(12)
        await expect(async () => {
          await popup.reload()
          await expect(popup.locator('option', { hasText: 'Stream · playback' })).toHaveCount(1, {
            timeout: 1200
          })
        }).toPass({ timeout: 6000 })
        await page.goto('about:blank')
      } finally {
        media.closeAllConnections()
        media.close()
      }
    })
    // Chromium's automation download handler bypasses extension filename listeners.
    const cdp = await browser.newCDPSession(page)
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' })
    // This click starts a browser download and exercises onDeterminingFilename.
    await page.setContent(`<a href="${origin.url()}">Download</a>`)
    await page.getByRole('link').click()
    await expect.poll(() => idlinux.api.pendingLinks(), { timeout: 15000 }).toHaveLength(1)
    const [offer] = await idlinux.api.pendingLinks()
    expect(offer.url).toBe(origin.url())
    await idlinux.page.getByRole('button', { name: 'Download', exact: true }).click()
    const done = await idlinux.waitForHttpStatus('completed')
    expect(sha256(await readFile(done.destinationPath))).toBe(origin.sha256)
    expect(await idlinux.api.pendingLinks()).toHaveLength(0)
  } finally {
    await browser.close()
  }
})
