import clsx from 'clsx'
import type { Badge } from '@/lib/types'

interface Props {
  badges?: Badge[]
  size?: 'sm' | 'md'
}

export default function BadgeList({ badges, size = 'sm' }: Props) {
  if (!badges || badges.length === 0) return null
  return (
    <div className={clsx('flex flex-wrap', size === 'sm' ? 'gap-1' : 'gap-2')}>
      {badges.map(b => (
        <span
          key={b.id}
          title={b.description}
          className={clsx(
            'badge inline-flex items-center gap-1 cursor-help',
            b.color,
            size === 'sm' ? 'text-xs' : 'text-sm px-2.5 py-1',
          )}
        >
          <span aria-hidden>{b.emoji}</span>
          <span>{b.label}</span>
        </span>
      ))}
    </div>
  )
}
