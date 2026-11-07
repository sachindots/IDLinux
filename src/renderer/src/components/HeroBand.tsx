import { cn } from 'cn'

export function HeroBand({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('transfer-band mx-4 mt-3 rounded-lg px-4 py-4 text-foreground', className)}>
      {children}
    </div>
  )
}
