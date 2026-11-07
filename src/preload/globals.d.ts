import type { IDLinuxApi } from './index'

declare global {
  interface Window {
    idlinux: IDLinuxApi
  }
}
