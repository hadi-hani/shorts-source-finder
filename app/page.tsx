'use client'

import { useState } from 'react'

type Match = { url: string; title: string; source: string }

export default function Home() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Match[] | null>(null)
  const [thumbnail, setThumbnail] = useState('')
  const [error, setError] = useState('')
  const [method, setMethod] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return

    setLoading(true)
    setError('')
    setResults(null)
    setThumbnail('')
    setMethod('')

    try {
      const res = await fetch('/api/find-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
      } else {
        setResults(data.matches || [])
        setThumbnail(data.thumbnailUrl || '')
        setMethod(data.method || '')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#f0f0f0',
      fontFamily: '\'Segoe UI\', system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '40px 20px',
    }}>
      <div style={{ width: '100%', maxWidth: '680px' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>🔍</div>
          <h1 style={{ fontSize: '28px', fontWeight: 700, margin: 0, color: '#fff' }}>
            YouTube Shorts Source Finder
          </h1>
          <p style={{ marginTop: '10px', color: '#888', fontSize: '15px' }}>
            أدخل رابط YouTube Shorts واحصل على عنوان الفيديو الأصلي
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '10px', marginBottom: '30px' }}>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/shorts/..."
            style={{
              flex: 1,
              padding: '14px 18px',
              borderRadius: '10px',
              border: '1px solid #333',
              background: '#1a1a1a',
              color: '#fff',
              fontSize: '14px',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '14px 24px',
              borderRadius: '10px',
              border: 'none',
              background: loading ? '#444' : '#ff4444',
              color: '#fff',
              fontWeight: 600,
              fontSize: '14px',
              cursor: loading ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {loading ? 'جاري البحث...' : 'بحث 🔎'}
          </button>
        </form>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '40px', color: '#888' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px', animation: 'spin 1s linear infinite' }}>⏳</div>
            <p>جاري البحث... قد يستغرق حتى 30 ثانية</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            padding: '16px',
            borderRadius: '10px',
            background: '#2a0a0a',
            border: '1px solid #cc2222',
            color: '#ff6666',
            marginBottom: '20px',
          }}>
            ❌ {error}
          </div>
        )}

        {/* Results */}
        {results !== null && (
          <div>
            {/* Thumbnail + method */}
            {thumbnail && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px', padding: '16px', background: '#111', borderRadius: '12px', border: '1px solid #222' }}>
                <img src={thumbnail} alt="Thumbnail" style={{ width: '120px', borderRadius: '8px', flexShrink: 0 }} />
                <div>
                  <p style={{ color: '#666', fontSize: '12px', margin: '0 0 4px' }}>الصورة المستخدمة في البحث</p>
                  {method && (
                    <span style={{ background: '#1a3a1a', color: '#4caf50', padding: '3px 10px', borderRadius: '999px', fontSize: '12px' }}>
                      ✅ {method}
                    </span>
                  )}
                </div>
              </div>
            )}

            {results.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#666', background: '#111', borderRadius: '12px', border: '1px solid #222' }}>
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>😔</div>
                <p style={{ fontSize: '16px' }}>لم يتم العثور على نتائج</p>
                <p style={{ fontSize: '13px', marginTop: '8px' }}>تأكد من أن الرابط صحيح ومن أن الفيديو ليس خاصاً</p>
              </div>
            ) : (
              <div>
                <h2 style={{ fontSize: '16px', color: '#888', marginBottom: '16px', fontWeight: 500 }}>
                  تم العثور على {results.length} نتيجة
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {results.map((match, i) => (
                    <a
                      key={i}
                      href={match.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'block',
                        padding: '16px 20px',
                        background: '#111',
                        border: '1px solid #2a2a2a',
                        borderRadius: '12px',
                        textDecoration: 'none',
                        transition: 'border-color 0.2s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = '#ff4444')}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a2a2a')}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                        <span style={{ color: '#ff4444', fontWeight: 700, fontSize: '18px', flexShrink: 0 }}>▶</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {match.title && (
                            <div style={{ color: '#fff', fontSize: '15px', fontWeight: 600, marginBottom: '4px', lineHeight: 1.4 }}>
                              {match.title}
                            </div>
                          )}
                          {match.source && (
                            <div style={{ color: '#888', fontSize: '13px', marginBottom: '6px' }}>{match.source}</div>
                          )}
                          <div style={{ color: '#555', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {match.url}
                          </div>
                        </div>
                        <span style={{ color: '#555', fontSize: '12px', flexShrink: 0 }}>↗</span>
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
