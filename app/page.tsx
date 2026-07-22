'use client'

import { useState } from 'react'

type Match = { url: string; title: string; source: string }

export default function Home() {
  const [url, setUrl] = useState('')
  const [provider, setProvider] = useState<'auto' | 'apify' | 'serpapi'>('apify')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Match[] | null>(null)
  const [thumbnail, setThumbnail] = useState('')
  const [frameUrls, setFrameUrls] = useState<string[]>([])
  const [error, setError] = useState('')
  const [method, setMethod] = useState('')
  const [statusMsg, setStatusMsg] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return
    setLoading(true)
    setError('')
    setResults(null)
    setThumbnail('')
    setFrameUrls([])
    setMethod('')
    setStatusMsg(provider === 'apify' ? '⏳ جاري استخراج الفريمات وإرسالها لـ Apify...' : '⏳ جاري البحث...')
    try {
      const res = await fetch('/api/find-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), provider }),
      })
      const data = await res.json()
      if (data.error) {
        setError(data.error)
      } else {
        setResults(data.matches || [])
        setThumbnail(data.thumbnailUrl || '')
        setFrameUrls(data.frameUrls || [])
        setMethod(data.method || '')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
      setStatusMsg('')
    }
  }

  const s = {
    page: {
      minHeight: '100vh', background: '#0d0d0d', color: '#e8e8e8',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
      padding: '40px 16px',
    },
    wrap: { width: '100%', maxWidth: '720px' },
    hero: { textAlign: 'center' as const, marginBottom: '36px' },
    h1: { fontSize: '26px', fontWeight: 700, margin: '0 0 8px', color: '#fff' },
    sub: { color: '#666', fontSize: '14px', margin: 0 },
    card: { background: '#151515', border: '1px solid #222', borderRadius: '14px', padding: '20px', marginBottom: '20px' },
    label: { color: '#888', fontSize: '12px', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '8px', display: 'block' },
    input: {
      width: '100%', padding: '12px 16px', borderRadius: '8px',
      border: '1px solid #2a2a2a', background: '#0d0d0d', color: '#fff',
      fontSize: '14px', outline: 'none', boxSizing: 'border-box' as const,
    },
    row: { display: 'flex', gap: '10px', marginTop: '12px' },
    providerBtn: (active: boolean) => ({
      flex: 1, padding: '10px', borderRadius: '8px', border: `1px solid ${active ? '#ff4444' : '#2a2a2a'}`,
      background: active ? '#2a0000' : '#111', color: active ? '#ff6666' : '#666',
      fontSize: '13px', fontWeight: active ? 600 : 400, cursor: 'pointer',
    }),
    submitBtn: (disabled: boolean) => ({
      width: '100%', marginTop: '14px', padding: '14px',
      borderRadius: '10px', border: 'none',
      background: disabled ? '#1a1a1a' : '#cc2222', color: disabled ? '#444' : '#fff',
      fontWeight: 700, fontSize: '15px', cursor: disabled ? 'not-allowed' : 'pointer',
    }),
    status: { textAlign: 'center' as const, padding: '30px', color: '#666', fontSize: '14px' },
    errBox: {
      padding: '14px 16px', borderRadius: '10px', background: '#180808',
      border: '1px solid #aa2222', color: '#ff7777', marginBottom: '16px', fontSize: '14px',
    },
    framesRow: { display: 'flex', gap: '8px', overflowX: 'auto' as const, paddingBottom: '4px' },
    frameImg: { width: '100px', height: '70px', objectFit: 'cover' as const, borderRadius: '6px', border: '1px solid #2a2a2a', flexShrink: 0 },
    emptyBox: {
      textAlign: 'center' as const, padding: '40px', color: '#555',
      background: '#111', borderRadius: '12px', border: '1px solid #1e1e1e',
    },
    matchLink: {
      display: 'block', padding: '14px 16px', background: '#111',
      border: '1px solid #222', borderRadius: '10px', textDecoration: 'none', marginBottom: '10px',
    },
    matchTitle: { color: '#eee', fontSize: '14px', fontWeight: 600, marginBottom: '3px', lineHeight: 1.4 },
    matchSource: { color: '#666', fontSize: '12px', marginBottom: '4px' },
    matchUrl: { color: '#444', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
    badge: (m: string) => ({
      display: 'inline-block', padding: '3px 10px', borderRadius: '999px', fontSize: '11px',
      background: m === 'apify' ? '#0d2a1a' : '#0d1a2a',
      color: m === 'apify' ? '#4dbb77' : '#4d9bbb',
    }),
  }

  return (
    <main style={s.page}>
      <div style={s.wrap}>

        {/* Hero */}
        <div style={s.hero}>
          <div style={{ fontSize: '42px', marginBottom: '10px' }}>🔍</div>
          <h1 style={s.h1}>YouTube Shorts — باحث المصدر الأصلي</h1>
          <p style={s.sub}>أدخل رابط Shorts وسيتم استخراج فريمات الفيديو والبحث عن المصدر الأصلي</p>
        </div>

        {/* Input card */}
        <div style={s.card}>
          <form onSubmit={handleSubmit}>
            <label style={s.label}>رابط الفيديو</label>
            <input
              style={s.input}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/shorts/xxxxxxxxxx"
              dir="ltr"
            />

            <label style={{ ...s.label, marginTop: '16px' }}>محرك البحث البصري</label>
            <div style={s.row}>
              {(['apify', 'serpapi', 'auto'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  style={s.providerBtn(provider === p)}
                  onClick={() => setProvider(p)}
                >
                  {p === 'apify' ? '🤖 Apify' : p === 'serpapi' ? '🔎 SerpApi' : '⚡ Auto'}
                </button>
              ))}
            </div>

            <button
              type="submit"
              disabled={loading || !url.trim()}
              style={s.submitBtn(loading || !url.trim())}
            >
              {loading ? statusMsg || '⏳ جاري البحث...' : '🔍 ابحث عن المصدر الأصلي'}
            </button>
          </form>
        </div>

        {/* Error */}
        {error && <div style={s.errBox}>❌ {error}</div>}

        {/* Loading */}
        {loading && (
          <div style={s.status}>
            <div style={{ fontSize: '28px', marginBottom: '10px' }}>⏳</div>
            <div>{statusMsg}</div>
            {provider === 'apify' && (
              <div style={{ marginTop: '8px', fontSize: '12px', color: '#444' }}>
                Apify يستخرج الفريمات ويبحث بصرياً — قد يستغرق حتى 3 دقائق
              </div>
            )}
          </div>
        )}

        {/* Results */}
        {!loading && results !== null && (
          <div>
            {/* Frames preview */}
            {frameUrls.length > 0 && (
              <div style={{ ...s.card, marginBottom: '16px' }}>
                <label style={s.label}>الفريمات المستخدمة في البحث البصري</label>
                <div style={s.framesRow}>
                  {frameUrls.map((fu, i) => (
                    <img key={i} src={fu} style={s.frameImg} alt={`frame ${i + 1}`}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Method badge */}
            {method && (
              <div style={{ marginBottom: '14px' }}>
                <span style={s.badge(method)}>✅ {method}</span>
              </div>
            )}

            {results.length === 0 ? (
              <div style={s.emptyBox}>
                <div style={{ fontSize: '40px', marginBottom: '12px' }}>😕</div>
                <div style={{ fontSize: '15px', color: '#777' }}>لم يتم العثور على نتائج</div>
                <div style={{ fontSize: '12px', color: '#444', marginTop: '8px' }}>
                  تأكد من أن الفيديو عام وليس خاصاً، أو جرب محرك بحث آخر
                </div>
              </div>
            ) : (
              <div>
                <div style={{ color: '#666', fontSize: '13px', marginBottom: '14px' }}>
                  تم العثور على <strong style={{ color: '#eee' }}>{results.length}</strong> نتيجة
                </div>
                {results.map((match, i) => (
                  <a
                    key={i}
                    href={match.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={s.matchLink}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#ff4444')}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#222')}
                  >
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                      <span style={{ color: '#ff4444', fontWeight: 700, flexShrink: 0, fontSize: '16px' }}>
                        #{i + 1}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {match.title && <div style={s.matchTitle}>{match.title}</div>}
                        {match.source && <div style={s.matchSource}>{match.source}</div>}
                        <div style={s.matchUrl}>{match.url}</div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </main>
  )
}
