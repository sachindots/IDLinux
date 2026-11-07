import { Film, List, Plus, Send } from 'lucide-react'
import { useState } from 'react'
import { ActionErrorDialog } from './ActionErrorDialog'
import { useAppStore } from '../store/useAppStore'

export function TransferNav(): React.JSX.Element {
  const queue = useAppStore((s) => s.view.name === 'list')
  const setView = useAppStore((s) => s.setView)
  const newDownload = useAppStore((s) => s.openNewDownload)
  const telegram = useAppStore((s) => s.openTelegram)
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null)
  const video = async (): Promise<void> => {
    try {
      await window.idlinux.openVideo('')
    } catch (error) {
      setFailure({
        title: 'Video window unavailable',
        message: error instanceof Error ? error.message : 'Could not open the video window.'
      })
    }
  }
  return (
    <nav className="transfer-nav" aria-label="Download workspace">
      <button
        className="nav-add"
        onClick={() => newDownload()}
        title="New download"
        aria-label="New download"
      >
        <Plus /> <span>New download</span>
      </button>
      <button
        aria-current={queue ? 'page' : undefined}
        onClick={() => setView({ name: 'list' })}
        title="Transfer queue"
        aria-label="Transfer queue"
      >
        <List /> <span>Transfer queue</span>
      </button>
      <button onClick={() => void video()} title="Download a video" aria-label="Download a video">
        <Film /> <span>Web video</span>
      </button>
      <button onClick={() => telegram()} title="Telegram" aria-label="Telegram">
        <Send /> <span>Telegram</span>
      </button>
      <ActionErrorDialog failure={failure} onClose={() => setFailure(null)} />
    </nav>
  )
}
