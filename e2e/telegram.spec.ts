import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TelegramMediaType } from '../src/shared/types'
import { expect, test, type IDLinuxApp } from './fixtures'
import { seededBytes } from './origin'

// Downloading from Telegram: the service is the e2e double (IDLINUX_E2E_TELEGRAM_FAKE=1), so
// the real transfer, manager, queue and persistence run against a source that serves seeded
// bytes and inflicts the DC's faults — a flood-wait, a stale file reference, per-region caps
// on the request size, and a photo whose size only the download itself learns.

const KB = 1024

/** Reads the finished download from the destination and compares it byte for byte with the
 * fake's seeded output — a halving or retry bug that wrote the right size in wrong places
 * would fail here. The bytes match because the double's generator and `seededBytes` are the
 * same xorshift from the same seed. */
async function expectDownloadedBytes(
  idlinux: IDLinuxApp,
  namePrefix: string,
  size: number,
  seed: number
): Promise<void> {
  const names = await readdir(idlinux.dirs.dest)
  const name = names.find((entry) => entry.startsWith(namePrefix))
  expect(name, `${namePrefix} should be in the destination`).toBeDefined()
  const actual = await readFile(join(idlinux.dirs.dest, name!))
  expect(
    actual.equals(seededBytes(size, seed)),
    `${namePrefix}'s bytes should match the fake's seeded output`
  ).toBe(true)
}

test.use({
  appEnv: {
    IDLINUX_E2E_TELEGRAM_FAKE: '1',
    // 500ms a chunk: a 3 MiB file takes ~3s, leaving a solid window to pause it mid-flight.
    IDLINUX_E2E_TELEGRAM_DELAY_MS: '500'
  }
})

async function startItem(
  idlinux: IDLinuxApp,
  messageId: number,
  mediaType: TelegramMediaType,
  fileName: string,
  totalBytes: number
): Promise<string> {
  return idlinux.api.startDownload({
    kind: 'telegram',
    messageId,
    mediaType,
    url: `telegram://saved-messages/${messageId}`,
    destinationDir: idlinux.dirs.dest,
    suggestedFileName: fileName,
    totalBytes,
    supportsRanges: true,
    interfaceIds: (await idlinux.api.listInterfaces()).map((iface) => iface.id),
    etag: null,
    lastModified: null
  })
}

test.describe('Telegram Saved Messages downloads', () => {
  test('signs in through the dialog, lists media, and downloads a video and a photo @smoke', async ({
    idlinux
  }) => {
    // The dialog saves where the app's destination setting says: point it at the test's folder
    // and relaunch, so the files land where the byte check reads them.
    await idlinux.api.updateSettings({ destinationDir: idlinux.dirs.dest })
    await idlinux.relaunch()

    await idlinux.page.getByRole('button', { name: 'Telegram' }).first().click()
    await idlinux.page.locator('#tg-api-id').fill('12345')
    await idlinux.page.locator('#tg-api-hash').fill('fake-hash')
    await idlinux.page.locator('#tg-phone').fill('+1 555 010 1234')
    await idlinux.page.getByRole('button', { name: 'Send code' }).click()

    // Signed in: the media browser is there, the login form isn't.
    const list = idlinux.page.getByRole('group', { name: 'Saved Messages media' })
    await list.waitFor()
    await expect(idlinux.page.locator('#tg-api-id')).toHaveCount(0)
    await expect(list).toContainText('clip.mp4')
    await expect(list).toContainText('shot.jpg')

    await idlinux.page.getByText('clip.mp4').click()
    await idlinux.page.getByText('shot.jpg').click()
    await idlinux.page.getByRole('button', { name: /Download 2/ }).click()

    await expect
      .poll(
        async () => (await idlinux.all()).filter((state) => state.status === 'completed').length,
        {
          timeout: 30_000
        }
      )
      .toBe(2)
    const finished = (await idlinux.all()).filter((state) => state.status === 'completed')
    // The video's size was known ahead; the photo's size only the download itself learned.
    // (Completion order and name suffixes aren't: whichever finished first sorts first.)
    const video = finished.find((state) => state.fileName.startsWith('clip'))
    const photo = finished.find((state) => state.fileName.startsWith('shot'))
    expect(video?.totalBytes).toBe(3 * KB * KB)
    expect(photo?.totalBytes).toBe(2 * KB * KB)
    // And the bytes are the fake's, in the right places.
    await expectDownloadedBytes(idlinux, 'clip', 3 * KB * KB, 11)
    await expectDownloadedBytes(idlinux, 'shot', 2 * KB * KB, 22)
  })

  test('a flaky file survives a flood-wait, a stale file reference and region caps', async ({
    idlinux
  }) => {
    const id = await startItem(idlinux, 3, 'document', 'flaky.zip', 3 * KB * KB)
    const done = await idlinux.waitForStatus('completed', 30_000)
    expect(done.id).toBe(id)
    expect(done.totalBytes).toBe(3 * KB * KB)
    await expectDownloadedBytes(idlinux, 'flaky', 3 * KB * KB, 33)
  })

  test('a paused download resumes after a relaunch', async ({ idlinux }) => {
    const id = await startItem(idlinux, 1, 'video', 'clip.mp4', 3 * KB * KB)
    // Pause straight away: the chunks take 500ms each, so this lands mid-download.
    await idlinux.api.pauseDownload(id)
    const paused = await idlinux.waitForStatus('paused', 15_000)
    expect(paused.id).toBe(id)

    await idlinux.relaunch()
    const restored = (await idlinux.all()).find((state) => state.id === id)
    expect(restored?.status).toBe('paused')

    await idlinux.api.resumeDownload(id)
    const done = await idlinux.waitForStatus('completed', 30_000)
    expect(done.id).toBe(id)
  })
})
