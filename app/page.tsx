'use client'
import { useState } from 'react'

type Match = { url: string; title: string; source: string }
type Result = {
  videoId?: string
  thumbnailUrl?: string
  matches?: Match[]
  note?: string
}

export default function Home() {
  const [url, setUrl] = useState('')
  const [provider, setProvider] = useState('apify')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setResult(null)
    setError('')

    try {
      const res = await fetch('/api/find-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, provider }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Something went wrong')
      setResult(data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="page-wrap">
      <div className="header">
        <svg className="logo-icon" viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="10" cy="16" r="3" fill="currentColor" opacity="0.4" />
          <circle cx="22" cy="10" r="3" fill="currentColor" />
          <path d="M13 16 Q16 10 19 10" stroke="currentColor" strokeWidth="1.5" fill="none" strokeDasharray="2 2" />
          <path d="M19 8.5 L22 10 L19 11.5" fill="currentColor" />
        </svg>
        <div>
          <h1>Shorts Source Finder</h1>
          <p>Find the original source of a YouTube Short</p>
        </div>
      </div>

      <div className="card">
        <form className="card-body" onSubmit={handleSubmit}>
          <div>
            <label className="form-label" htmlFor="shortsUrl">YouTube Shorts URL</label>
            <input
              id="shortsUrl"
              type="url"
              className="form-input"
              placeholder="https://youtube.com/shorts/abc123"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div>
            <label className="form-label" htmlFor="provider">Search Provider</label>
            <select
              id="provider"
              className="form-select"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="serpapi">SerpApi — Google Lens (instant)</option>
              <option value="apify">Apify — Google Lens (async, ~1 min)</option>
            </select>
          </div>

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? (
              <span className="spinner" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
            )}
            {loading ? 'Searching...' : 'Find Original Source'}
          </button>
        </form>

        {(error || result) && (
          <div className="result-area">
            {error && (
              <div className="error-box">{error}</div>
            )}

            {result && (
              <>
                {result.thumbnailUrl && (
                  <div className="thumb-wrap">
                    <img src={result.thumbnailUrl} alt="Video thumbnail" loading="lazy" />
                  </div>
                )}

                {result.note && (
                  <div className="warning-box">{result.note}</div>
                )}

                {result.matches && result.matches.length > 0 ? (
                  <>
                    <p className="results-label">Source Videos Found</p>
                    {result.matches.map((m, i) => (
                      <div key={i} className="match-item">
                        <a href={m.url} target="_blank" rel="noopener noreferrer">
                          {m.title || m.url}
                        </a>
                        {m.source && <div className="match-source">{m.source}</div>}
                      </div>
                    ))}
                  </>
                ) : result.matches ? (
                  <p className="no-results">No source videos found.</p>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
