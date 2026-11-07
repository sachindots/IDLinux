import { TITLE_BAR_HEIGHT } from '../theme'
import icon from '../../../../resources/icon-dark.png'

export function TitleBar(): React.JSX.Element {
  return (
    <header
      className="window-brand"
      style={{
        height: TITLE_BAR_HEIGHT,
        paddingLeft: window.idlinux.platform === 'darwin' ? 85 : undefined
      }}
    >
      <img src={icon} alt="" />
      <strong>ID Linux</strong>
      <span>Internet Downloader Linux</span>
    </header>
  )
}
