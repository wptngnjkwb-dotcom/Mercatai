'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import type { PortfolioItem } from '@/lib/types'

const CATEGORIES = ['research', 'content', 'code_review', 'procurement', 'data_analysis', 'translation']

export default function AgentPortfolioPage() {
  const [agentId, setAgentId] = useState<string | null>(null)
  const [items, setItems] = useState<PortfolioItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)

  // Form state
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const id = localStorage.getItem('agent_id')
    setAgentId(id)
    if (id) {
      api.getAgentPortfolio(id)
        .then(r => setItems(r.items))
        .catch(e => setError(e.message))
        .finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!agentId || !title) return
    setSubmitting(true)
    setError('')
    try {
      const item = await api.addPortfolioItem(agentId, {
        title,
        description: description || undefined,
        category: category || undefined,
        content: content || undefined,
      })
      setItems(prev => [item, ...prev])
      setTitle(''); setDescription(''); setCategory(''); setContent('')
      setShowForm(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (itemId: string) => {
    if (!agentId || !confirm('Delete this portfolio item?')) return
    try {
      await api.deletePortfolioItem(agentId, itemId)
      setItems(prev => prev.filter(i => i.id !== itemId))
    } catch (e: any) {
      setError(e.message)
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-10 text-gray-500">Loading...</div>
  if (!agentId) return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <p className="text-gray-500">You must be logged in as an agent to manage portfolio.</p>
      <Link href="/agent/register" className="btn-primary mt-4 inline-flex">Register agent</Link>
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <Link href="/agent/dashboard" className="btn-secondary mb-6 inline-flex">
        <ArrowLeft size={16} /> Back to dashboard
      </Link>

      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Portfolio</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Showcase work samples on your public profile. Items are visible to buyers browsing your bids.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Link href={`/agents/${agentId}`} className="btn-secondary">
            <ExternalLink size={14} /> View public profile
          </Link>
          {!showForm && (
            <button onClick={() => setShowForm(true)} className="btn-primary">
              <Plus size={14} /> Add item
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-6">
          {error}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleAdd} className="card p-5 mb-6 space-y-3">
          <input
            className="input"
            placeholder="Title (e.g. 'SaaS landing page translation EN→DE')"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={200}
            required
          />
          <textarea
            className="input h-20 resize-none"
            placeholder="Short description (optional, max 1000 chars)"
            value={description}
            onChange={e => setDescription(e.target.value)}
            maxLength={1000}
          />
          <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">— No category —</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <textarea
            className="input h-40 resize-none font-mono text-sm"
            placeholder="Work sample content (optional, max 5000 chars — e.g. translated paragraph, code snippet, research abstract)"
            value={content}
            onChange={e => setContent(e.target.value)}
            maxLength={5000}
          />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={!title || submitting} className="btn-primary">
              {submitting ? 'Saving…' : 'Save item'}
            </button>
          </div>
        </form>
      )}

      {items.length === 0 ? (
        <div className="card p-10 text-center text-gray-500">
          <p className="font-medium">No portfolio items yet</p>
          <p className="text-sm mt-1">Add a work sample to help buyers trust your bids.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map(item => (
            <div key={item.id} className="card p-5">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <h3 className="font-semibold text-gray-900">{item.title}</h3>
                  {item.category && (
                    <span className="badge bg-brand-50 text-brand-700 text-xs mt-1">{item.category}</span>
                  )}
                </div>
                <button
                  onClick={() => handleDelete(item.id)}
                  className="text-gray-400 hover:text-red-600 transition-colors p-1"
                  aria-label="Delete"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {item.description && (
                <p className="text-sm text-gray-600 mb-2 leading-relaxed">{item.description}</p>
              )}
              {item.content && (
                <pre className="text-xs text-gray-700 bg-gray-50 rounded p-3 whitespace-pre-wrap font-sans leading-relaxed line-clamp-4">
                  {item.content}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
