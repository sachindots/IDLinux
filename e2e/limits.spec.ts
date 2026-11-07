import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataPeriodKey, nextDataReset } from '../src/shared/dataLimits'
import { BLOCK, expect, test } from './fixtures'
import { seededBytes, sha256 } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

// Speed & data limits (main/network/limits.ts): every byte received goes through them, whether
// an HTTP response's or a torrent peer's. The checks fixture verifies each finished download's
// bytes, which is what matters most here: holding a connection back must never garble it.

const KB = 1024

test.describe('speed and data limits', () => {
  test('a total speed limit holds a download to it', async ({ idlinux, serve }) => {
    const origin = await serve({ size: 16 * BLOCK })
    await idlinux.api.updateSettings({ speedLimit: 256 * KB })
    const started = Date.now()
    await idlinux.start(origin.url(), origin.sha256)
    await idlinux.waitForHttpStatus('completed', 30_000)
    // 1 MB at 256 KB/s: four seconds, less the second's worth a bucket may hold.
    expect(Date.now() - started).toBeGreaterThan(2500)
  })

  test('slow mode holds downloads to its speed, the default one included', async ({
    idlinux,
    serve
  }) => {
    const origin = await serve({ size: 96 * BLOCK })
    // Switched on as the status bar does, its speed never changed: 2 MB/s.
    await idlinux.api.updateSettings({ slowMode: true })
    const started = Date.now()
    await idlinux.start(origin.url(), origin.sha256)
    await idlinux.waitForHttpStatus('completed', 30_000)
    // 6 MB at 2 MB/s: three seconds, less the second's worth a bucket may hold.
    expect(Date.now() - started).toBeGreaterThan(1800)
  })

  for (const period of ['day', 'week', 'month'] as const) {
    test(`a network stops at its ${period} limit and resumes when it is raised`, async ({
      idlinux,
      serve
    }) => {
      const origin = await serve({ size: 16 * BLOCK })
      await idlinux.api.updateSettings({
        networkPreferences: { a: { dataLimit: 4 * BLOCK, dataLimitPeriod: period } }
      })
      const id = await idlinux.start(origin.url(), origin.sha256)

      const stopped = await idlinux.waitUntil((state) =>
        state.networks.some((network) => network.id === 'a' && network.status === 'limit')
      )
      expect(stopped.status).toBe('downloading')
      expect(stopped.bytesDownloaded).toBeLessThan(16 * BLOCK)
      expect((await idlinux.api.networkUsage()).a).toBeGreaterThanOrEqual(4 * BLOCK)

      await idlinux.api.updateSettings({
        networkPreferences: { a: { dataLimit: 1024 * BLOCK, dataLimitPeriod: period } }
      })
      await idlinux.waitForHttpStatus('completed')
      expect((await idlinux.byId(id))?.status).toBe('completed')
    })
  }

  test('a torrent under a speed limit still arrives whole', async ({ idlinux }) => {
    const swarm = await new Swarm().start()
    try {
      const data = seededBytes(1024 * KB, 31)
      const torrent = await swarm.seed([named(data, 'limited.bin')], { pieceLength: 64 * KB })
      await idlinux.api.updateSettings({ speedLimit: 384 * KB })
      const started = Date.now()
      await idlinux.start(await torrentFileOnDisk(torrent), sha256(data))
      await idlinux.waitForTorrentStatus('completed', 30_000)
      expect(Date.now() - started).toBeGreaterThan(1500)
    } finally {
      await swarm.stop()
    }
  })
})

test('usage survives period switches and restart, and expired calendar periods reset', async ({
  idlinux,
  dirs
}) => {
  await idlinux.quit()
  const now = Date.now()
  await writeFile(
    join(dirs.userData, 'network-usage.json'),
    JSON.stringify({
      version: 2,
      periods: Object.fromEntries(
        ['day', 'week', 'month'].map((period, index) => [
          period,
          {
            key: dataPeriodKey(period as 'day' | 'week' | 'month', now),
            bytes: { a: (index + 1) * 1024 }
          }
        ])
      )
    })
  )
  await idlinux.launch()
  for (const [period, count] of [
    ['day', 1024],
    ['week', 2048],
    ['month', 3072]
  ] as const) {
    await idlinux.api.updateSettings({
      networkPreferences: { a: { dataLimit: 1024 ** 3, dataLimitPeriod: period } }
    })
    expect((await idlinux.api.networkUsage()).a).toBe(count)
  }
  await idlinux.quit()
  await idlinux.launch()
  expect((await idlinux.api.networkUsage()).a).toBe(3072)
  const future = nextDataReset('month', now).getTime() + 8 * 86400_000
  await idlinux.evaluateMain((_electron, at) => {
    const original = Date.now
    ;(globalThis as Record<string, unknown>).__originalDateNow = original
    Date.now = () => at
  }, future)
  try {
    for (const period of ['day', 'week', 'month'] as const) {
      await idlinux.api.updateSettings({
        networkPreferences: { a: { dataLimit: 1024 ** 3, dataLimitPeriod: period } }
      })
      expect((await idlinux.api.networkUsage()).a ?? 0).toBe(0)
    }
  } finally {
    await idlinux.evaluateMain(() => {
      Date.now = (globalThis as Record<string, unknown>).__originalDateNow as () => number
      delete (globalThis as Record<string, unknown>).__originalDateNow
    }, null)
  }
})

test('existing monthly usage remains available after migration', async ({ idlinux, dirs }) => {
  await idlinux.quit()
  await writeFile(
    join(dirs.userData, 'network-usage.json'),
    JSON.stringify({
      month: dataPeriodKey('month', Date.now()),
      bytes: { a: 12345 }
    })
  )
  await idlinux.launch()
  expect((await idlinux.api.networkUsage()).a).toBe(12345)
  await idlinux.api.updateSettings({ networkPreferences: { a: { dataLimitPeriod: 'day' } } })
  expect((await idlinux.api.networkUsage()).a).toBe(0)
  await idlinux.api.updateSettings({ networkPreferences: { a: { dataLimitPeriod: 'month' } } })
  expect((await idlinux.api.networkUsage()).a).toBe(12345)
})

test('calendar periods use local midnight, Monday weeks, and correct year boundaries', () => {
  const sunday = new Date(2026, 9, 4, 23, 59, 59, 999).getTime()
  const monday = new Date(2026, 9, 5).getTime()
  expect(dataPeriodKey('week', sunday)).toBe('2026-09-28')
  expect(dataPeriodKey('week', monday)).toBe('2026-10-05')
  expect(nextDataReset('day', sunday).getTime()).toBe(monday)
  expect(nextDataReset('week', sunday).getTime()).toBe(monday)
  expect(nextDataReset('week', monday).getTime()).toBe(new Date(2026, 9, 12).getTime())
  expect(nextDataReset('month', new Date(2026, 11, 31, 23).getTime()).getTime()).toBe(
    new Date(2027, 0, 1).getTime()
  )
  expect(dataPeriodKey('month', new Date(2027, 0, 1).getTime())).toBe('2027-01')
})

for (const period of ['day', 'week', 'month'] as const) {
  test(`resetting ${period} usage preserves other periods and networks and survives restart`, async ({
    idlinux,
    serve
  }) => {
    const origin = await serve({ size: BLOCK })
    await idlinux.start(origin.url(), origin.sha256)
    await idlinux.waitForStatus('completed')
    const before = await idlinux.api.networkUsage()
    const id = Object.keys(before).find((key) => before[key] > 0)!
    expect(id).toBeTruthy()
    await idlinux.api.updateSettings({ networkPreferences: { [id]: { dataLimitPeriod: period } } })
    await idlinux.api.resetNetworkUsage(id)
    expect((await idlinux.api.networkUsage())[id]).toBe(0)
    for (const [other, bytes] of Object.entries(before)) {
      if (other !== id) expect((await idlinux.api.networkUsage())[other]).toBe(bytes)
    }
    for (const otherPeriod of ['day', 'week', 'month'] as const) {
      if (otherPeriod === period) continue
      await idlinux.api.updateSettings({
        networkPreferences: { [id]: { dataLimitPeriod: otherPeriod } }
      })
      expect((await idlinux.api.networkUsage())[id]).toBe(before[id])
    }
    await idlinux.api.updateSettings({ networkPreferences: { [id]: { dataLimitPeriod: period } } })
    await idlinux.relaunch()
    expect((await idlinux.api.networkUsage())[id]).toBe(0)
  })
}
