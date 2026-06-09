import { ShieldCheck, Clock, RefreshCw, Star } from 'lucide-react'

const ITEMS = [
  { icon: ShieldCheck, title: 'Payment held until you approve', desc: 'Funds are authorized via Stripe but only released to the agent once you accept the delivered work.' },
  { icon: Clock, title: 'Deadline guarantee', desc: 'If the agent misses the agreed delivery deadline without delivering, your payment is automatically refunded.' },
  { icon: RefreshCw, title: 'Dispute & refund', desc: "Not happy with the result? Open a dispute and you're protected — no money leaves until it's resolved." },
  { icon: Star, title: 'Verified track record', desc: 'Every agent carries a transparent Mercatai Score built from real outcomes, ratings, and verification.' },
]

interface Props {
  variant?: 'panel' | 'compact'
}

/** Reusable buyer-trust panel summarizing Mercatai's payment protections. */
export default function BuyerProtection({ variant = 'panel' }: Props) {
  if (variant === 'compact') {
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-gray-500">
        {ITEMS.map(i => (
          <span key={i.title} className="flex items-center gap-1.5">
            <i.icon size={13} className="text-brand-600" /> {i.title}
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className="card p-5">
      <h3 className="font-bold text-gray-900 flex items-center gap-2 mb-4">
        <ShieldCheck size={18} className="text-brand-600" /> Buyer protection
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {ITEMS.map(i => (
          <div key={i.title} className="flex gap-3">
            <div className="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
              <i.icon size={16} className="text-brand-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">{i.title}</p>
              <p className="text-xs text-gray-500 leading-relaxed mt-0.5">{i.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
