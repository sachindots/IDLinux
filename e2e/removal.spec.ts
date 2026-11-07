import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOCK, expect, test, treeSha, type IDLinuxApp } from './fixtures'
import { seededBytes } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

/** Hold the actual history save, rather than relying on a quick click landing in its window. */
async function holdHistoryWrite(idlinux: IDLinuxApp): Promise<void> {
  await idlinux.evaluateMain(() => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const { basename } = process.getBuiltinModule('node:path')
    const original = fs.rename
    const globals = globalThis as Record<string, unknown>
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    globals.__releaseHistory = () => {
      fs.rename = original
      release()
    }
    fs.rename = async (...args: Parameters<typeof original>) => {
      if (basename(String(args[1])) === 'history.json') {
        globals.__historyHeld = true
        await held
      }
      return original(...args)
    }
  }, null)
}

async function releaseHistoryWrite(idlinux: IDLinuxApp): Promise<void> {
  await idlinux.evaluateMain(() => {
    const globals = globalThis as Record<string, unknown>
    if (typeof globals.__releaseHistory === 'function') globals.__releaseHistory()
  }, null)
}

async function waitForHistoryWrite(idlinux: IDLinuxApp): Promise<void> {
  await expect
    .poll(() =>
      idlinux.evaluateMain(() => (globalThis as Record<string, unknown>).__historyHeld, null)
    )
    .toBe(true)
}

async function stubTrash(idlinux: IDLinuxApp, destination: string): Promise<void> {
  await mkdir(destination)
  await idlinux.evaluateMain(({ shell }, dest) => {
    shell.trashItem = async (path: string): Promise<void> => {
      const { rename } = process.getBuiltinModule('node:fs/promises')
      const { basename, join } = process.getBuiltinModule('node:path')
      await rename(path, join(dest, basename(path)))
    }
  }, destination)
}

test.describe('removal during completion @smoke', () => {
  for (const action of ['remove', 'clear', 'trash'] as const) {
    test(`${action} waits for the pending history save and stays removed after restart`, async ({
      idlinux,
      serve,
      dirs
    }) => {
      const trash = join(dirs.dest, 'test-trash')
      if (action === 'trash') await stubTrash(idlinux, trash)
      await holdHistoryWrite(idlinux)
      try {
        const origin = await serve({ size: BLOCK })
        const id = await idlinux.start(origin.url(), origin.sha256)
        await waitForHistoryWrite(idlinux)
        const completed = (await idlinux.api.listDownloads()).find(
          (entry) => entry.state.id === id
        )!.state
        expect(completed.status).toBe('completed')

        const removing =
          action === 'clear'
            ? idlinux.api.clearHistory()
            : idlinux.api.removeDownload(id, { trashFile: action === 'trash' })
        // Sent after removal on the same renderer IPC connection: removal has reached main.
        await idlinux.api.listDownloads()
        await releaseHistoryWrite(idlinux)
        await removing

        expect((await idlinux.api.listHistory()).find((entry) => entry.id === id)).toBeUndefined()
        expect(
          (await idlinux.api.listDownloads()).find((entry) => entry.state.id === id)
        ).toBeUndefined()
        expect(existsSync(completed.destinationPath)).toBe(action !== 'trash')
        if (action === 'trash') expect(existsSync(join(trash, completed.fileName))).toBe(true)
        await idlinux.relaunch()
        expect(await idlinux.all()).toEqual([])
      } finally {
        if (idlinux.alive) await releaseHistoryWrite(idlinux).catch(() => {})
      }
    })
  }

  test('trashing a just-finished torrent waits for its owned-file history record', async ({
    idlinux,
    dirs
  }) => {
    const swarm = await new Swarm().start()
    try {
      const files = [
        named(seededBytes(BLOCK, 121), 'a.bin'),
        named(seededBytes(BLOCK, 122), 'b.bin')
      ]
      const torrent = await swarm.seed(files, { folder: 'Finished', pieceLength: 16 * 1024 })
      const trash = join(dirs.dest, 'test-trash')
      await stubTrash(idlinux, trash)
      await holdHistoryWrite(idlinux)
      const id = await idlinux.start(
        await torrentFileOnDisk(torrent),
        treeSha(files.map((data) => ({ path: (data as { name?: string }).name!, data })))
      )
      await waitForHistoryWrite(idlinux)
      const completed = (await idlinux.api.listDownloads()).find(
        (entry) => entry.state.id === id
      )!.state
      await writeFile(join(completed.destinationPath, 'personal.txt'), 'keep me')
      const removing = idlinux.api.removeDownload(id, { trashFile: true })
      await idlinux.api.listDownloads()
      await releaseHistoryWrite(idlinux)
      await removing

      expect(await readFile(join(completed.destinationPath, 'personal.txt'), 'utf8')).toBe(
        'keep me'
      )
      for (const name of ['a.bin', 'b.bin']) {
        expect(existsSync(join(completed.destinationPath, name))).toBe(false)
        expect(existsSync(join(trash, name))).toBe(true)
      }
      expect(await idlinux.all()).toEqual([])
    } finally {
      if (idlinux.alive) await releaseHistoryWrite(idlinux).catch(() => {})
      await swarm.stop()
    }
  })
})

test('failed torrent cancellation stays visible across restart and can be retried @smoke', async ({
  idlinux,
  dirs
}) => {
  const swarm = await new Swarm().start()
  try {
    const files = [
      named(seededBytes(32 * BLOCK, 111), 'a.bin'),
      named(seededBytes(32 * BLOCK, 112), 'b.bin')
    ]
    const torrent = await swarm.seed(files, {
      folder: 'Partial',
      pieceLength: 16 * 1024,
      uploadLimit: 64 * 1024
    })
    const id = await idlinux.start(
      await torrentFileOnDisk(torrent),
      treeSha(files.map((data) => ({ path: (data as { name?: string }).name!, data })))
    )
    await idlinux.api.pauseDownload(id)
    const paused = await idlinux.waitForTorrentStatus('paused')
    await writeFile(join(paused.destinationPath, 'personal.txt'), 'keep me')
    const original = paused.destinationPath + '.original'
    await rename(paused.destinationPath, original)
    await symlink(original, paused.destinationPath, 'junction')

    await expect(idlinux.api.removeDownload(id)).rejects.toThrow(/folder is now a link/)
    const failed = await idlinux.waitForTorrentStatus('error')
    expect(failed.error).toMatch(/folder is now a link/)
    expect(failed.resumable).toBe(false)
    const row = idlinux.page.getByRole('button', { name: `Open ${paused.fileName}`, exact: true })
    await expect(row).toBeVisible()
    expect(
      idlinux.sessions
        .flat()
        .filter((state) => state.id === id)
        .some((state) => state.status === 'cancelled')
    ).toBe(false)
    const manifest = join(dirs.userData, 'downloads', id, 'manifest.json')
    expect(JSON.parse(await readFile(manifest, 'utf8')).state.status).toBe('error')

    await idlinux.relaunch()
    await expect(
      idlinux.page.getByRole('button', { name: `Open ${paused.fileName}`, exact: true })
    ).toBeVisible()
    expect((await idlinux.waitForTorrentStatus('error')).error).toMatch(/folder is now a link/)
    await unlink(paused.destinationPath)
    await rename(original, paused.destinationPath)
    await idlinux.api.removeDownload(id)
    expect(await idlinux.all()).toEqual([])
    expect(existsSync(manifest)).toBe(false)
    expect(await readFile(join(paused.destinationPath, 'personal.txt'), 'utf8')).toBe('keep me')
    for (const name of ['a.bin', 'b.bin'])
      expect(existsSync(join(paused.destinationPath, name))).toBe(false)
  } finally {
    await swarm.stop()
  }
})

test('cleanup failure keeps an active HTTP download visible and blocks resume during cancellation @smoke', async ({
  idlinux,
  serve,
  dirs
}) => {
  const origin = await serve({ size: 24 * BLOCK })
  const reached = origin.hold(7 * BLOCK)
  const id = await idlinux.start(origin.url(), origin.sha256)
  await reached
  const state = (await idlinux.currentHttp())!
  const staging = `${state.destinationPath}.idlinux`
  await idlinux.evaluateMain((_electron, path) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const original = fs.rm
    const globals = globalThis as Record<string, unknown>
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    globals.__releaseDiscard = () => {
      fs.rm = original
      release()
    }
    fs.rm = async (...args: Parameters<typeof original>) => {
      if (args[0] === path) {
        globals.__discardHeld = true
        await held
        throw Object.assign(new Error('Permission denied removing partial data'), {
          code: 'EACCES'
        })
      }
      return original(...args)
    }
  }, staging)
  try {
    const removing = idlinux.api.removeDownload(id).then(
      () => null,
      (error: Error) => error.message
    )
    await expect
      .poll(() =>
        idlinux.evaluateMain(() => (globalThis as Record<string, unknown>).__discardHeld, null)
      )
      .toBe(true)
    const alsoRemoving = idlinux.api.removeDownload(id).then(
      () => null,
      (error: Error) => error.message
    )
    await idlinux.api.resumeDownload(id)
    expect(
      (await idlinux.api.listDownloads()).find((entry) => entry.state.id === id)?.state.status
    ).toBe('paused')
    await expect(
      idlinux.page.getByRole('button', { name: `Open ${state.fileName}`, exact: true })
    ).toBeVisible()
    await idlinux.evaluateMain(() => {
      ;((globalThis as Record<string, unknown>).__releaseDiscard as () => void)()
    }, null)
    expect(await removing).toMatch(/Permission denied/)
    expect(await alsoRemoving).toMatch(/Permission denied/)
    const failed = await idlinux.waitForHttpStatus('error')
    expect(failed.resumable).toBe(false)
    expect(existsSync(staging)).toBe(true)
    expect(
      idlinux.sessions
        .flat()
        .filter((entry) => entry.id === id)
        .some((entry) => entry.status === 'cancelled')
    ).toBe(false)
    expect(
      JSON.parse(await readFile(join(dirs.userData, 'downloads', id, 'manifest.json'), 'utf8'))
        .state.status
    ).toBe('error')
    await idlinux.api.removeDownload(id)
    expect(existsSync(staging)).toBe(false)
    expect(await idlinux.all()).toEqual([])
  } finally {
    if (idlinux.alive)
      await idlinux
        .evaluateMain(() => {
          ;((globalThis as Record<string, unknown>).__releaseDiscard as () => void)()
        }, null)
        .catch(() => {})
    origin.release()
  }
})
