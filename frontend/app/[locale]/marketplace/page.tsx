'use client'

import { useEffect, useState } from 'react'
import { Search, Filter } from 'lucide-react'
import { useTranslations } from 'next-intl'
import TaskCard from '@/components/TaskCard'
import { api } from '@/lib/api'
import type { Task } from '@/lib/types'

export default function MarketplacePage() {
  const t = useTranslations('marketplace')

  const CATEGORIES = [
    { value: '', label: t('categories.all') },
    { value: 'research', label: t('categories.research') },
    { value: 'content', label: t('categories.content') },
    { value: 'code_review', label: t('categories.code_review') },
    { value: 'procurement', label: t('categories.procurement') },
    { value: 'data_analysis', label: t('categories.data_analysis') },
    { value: 'translation', label: t('categories.translation') },
  ]

  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    setLoading(true)
    api.listTasks({ status: 'open', ...(category ? { category } : {}) })
      .then(r => setTasks(r.tasks))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [category])

  const filtered = search
    ? tasks.filter(t =>
        t.title.toLowerCase().includes(search.toLowerCase()) ||
        t.description.toLowerCase().includes(search.toLowerCase())
      )
    : tasks

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">{t('title')}</h1>
        <p className="text-gray-500">{t('subtitle')}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            className="input pl-9"
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="relative">
          <Filter size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <select
            className="input pl-9 pr-8 appearance-none cursor-pointer"
            value={category}
            onChange={e => setCategory(e.target.value)}
          >
            {CATEGORIES.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card p-5 h-44 animate-pulse bg-gray-100" />
          ))}
        </div>
      ) : error ? (
        <div className="card p-8 text-center text-red-600">
          <p className="font-medium">{t('loadError')}</p>
          <p className="text-sm text-gray-500 mt-1">{error}</p>
          <p className="text-sm text-gray-400 mt-2">Make sure the backend is running on localhost:8000</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center text-gray-500">
          <p className="font-medium text-lg">{t('noTasks')}</p>
          <p className="text-sm mt-1">{t('noTasksHint')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map(task => (
            <TaskCard key={task.id} task={task} showBidButton />
          ))}
        </div>
      )}

      <p className="text-xs text-gray-400 text-center mt-8">
        {filtered.length !== 1 ? t('tasksShownPlural', { count: filtered.length }) : t('tasksShown', { count: filtered.length })}
      </p>
    </div>
  )
}
