import type { MercataiScoreValue as Score } from '@/lib/types'

const GRADE_COLOR: Record<string, { ring: string; text: string; bg: string }> = {
  'A+': { ring: '#059669', text: 'text-emerald-700', bg: 'bg-emerald-50' },
  'A':  { ring: '#0891b2', text: 'text-cyan-700',    bg: 'bg-cyan-50' },
  'B':  { ring: '#2563eb', text: 'text-blue-700',    bg: 'bg-blue-50' },
  'C':  { ring: '#d97706', text: 'text-amber-700',   bg: 'bg-amber-50' },
  'D':  { ring: '#9ca3af', text: 'text-gray-600',    bg: 'bg-gray-50' },
}

interface Props {
  score: Score
  size?: 'sm' | 'md' | 'lg'
  showBreakdown?: boolean
}

/**
 * Mercatai Score badge — a circular ring with the 0–100 score, grade, and an
 * optional component breakdown. The signature trust signal across the product.
 */
export default function MercataiScore({ score, size = 'md', showBreakdown = false }: Props) {
  const c = GRADE_COLOR[score.grade] ?? GRADE_COLOR['D']
  const dim = size === 'lg' ? 96 : size === 'sm' ? 48 : 68
  const stroke = size === 'lg' ? 8 : size === 'sm' ? 4 : 6
  const r = (dim - stroke) / 2
  const circ = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score.score)) / 100
  const numFont = size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-sm' : 'text-lg'

  return (
    <div className="flex items-center gap-3">
      <div className="relative shrink-0" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} className="-rotate-90">
          <circle cx={dim / 2} cy={dim / 2} r={r} fill="none" stroke="#e5e7eb" strokeWidth={stroke} />
          <circle
            cx={dim / 2} cy={dim / 2} r={r} fill="none"
            stroke={c.ring} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`font-bold text-gray-900 leading-none ${numFont}`}>{score.score}</span>
          {size !== 'sm' && <span className={`text-[10px] font-semibold ${c.text}`}>{score.grade}</span>}
        </div>
      </div>

      {(size !== 'sm' || showBreakdown) && (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500">Mercatai Score</span>
            <span className={`badge text-xs ${c.bg} ${c.text}`}>{score.label}</span>
          </div>
          {showBreakdown && (
            <div className="mt-2 flex flex-col gap-1.5 w-56">
              {score.components.map(comp => (
                <div key={comp.key}>
                  <div className="flex justify-between text-[11px] text-gray-500">
                    <span>{comp.label}</span>
                    <span className="tabular-nums">{comp.points}/{comp.max}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(comp.points / comp.max) * 100}%`, backgroundColor: c.ring }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
