import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'

export function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? 'Login failed')
        return
      }
      const data = await res.json()
      localStorage.setItem('sentry_token', data.token)
      navigate('/', { replace: true })
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-ink-deeper">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-ink-deep border border-white/10">
        <div className="font-sans font-bold text-[22px] text-fg-1 mb-2">Sentry</div>
        <div className="font-sans text-[13px] text-fg-3 mb-6">Sign in to continue</div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-[11px] font-semibold text-fg-3 mb-1 uppercase tracking-wider">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-ink-deeper border border-white/10 text-fg-1 text-[13px] outline-none focus:border-white/30"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-fg-3 mb-1 uppercase tracking-wider">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-ink-deeper border border-white/10 text-fg-1 text-[13px] outline-none focus:border-white/30"
              required
            />
          </div>
          {error && (
            <div className="text-[12px] text-red-400">{error}</div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="mt-2 py-2 rounded-lg bg-white text-black font-semibold text-[13px] hover:bg-white/90 transition disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
