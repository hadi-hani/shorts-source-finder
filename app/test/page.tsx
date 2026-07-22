'use client'

import { useState } from 'react'

type Match = { url: string; title: string; source: string }

export default function TestPage() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ videoId?: string; thumbnailUrl?: string; matches?: Match[]; error?: string; note?: string } | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch('/api/find-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json()
      setResult(data)
    } catch {
      setResult({ error: 'Network error — could not reach the API.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={{ fontFamily: 'sans-serif', maxWidth: 700, margin: '40px auto', padding: '0 20px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>🔍 Shorts Source Finder — Test</h1>
      <p style={{ color: '#555', marginBottom: 24 }}>أدخل رابط YouTube Short واحصل على الفيديو الأصلي</p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, marginBottom: 32 }}>
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/shorts/XXXXXXXXXXX"
          required
          style={{
            flex: 1, padding: '10px 14px', fontSize: 15,
            border: '1.5px solid #ccc', borderRadius: 8, outline: 'none'
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: '10px 22px', fontSize: 15, background: loading ? '#999' : '#0070f3',
            color: '#fff', border: 'none', borderRadius: 8, cursor: loading ? 'not-allowed' : 'pointer'
          }}
        >
          {loading ? '⏳ جاري البحث...' : 'بحث'}
        </button>
      </form>

      {loading && (
        <div style={{ textAlign: 'center', color: '#555', padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
          <p>يتم الآن تحميل الصورة المصغرة وإرسالها لـ Google Lens عبر Apify...</p>
          <p style={{ fontSize: 13, color: '#888' }}>قد يستغرق هذا من 30 إلى 120 ثانية</p>
        </div>
      )}

      {result && !loading && (
        <div>
          {result.error && (
            <div style={{ background: '#fff0f0', border: '1px solid #f00', borderRadius: 8, padding: 16, color: '#c00' }}>
              ❌ <strong>خطأ:</strong> {result.error}
            </div>
          )}

          {result.note && (
            <div style={{ background: '#fffbe6', border: '1px solid #f90', borderRadius: 8, padding: 16, color: '#7a5200', marginBottom: 16 }}>
              ⚠️ {result.note}
            </div>
          )}

          {result.videoId && (
            <div style={{ marginBottom: 20, background: '#f5f5f5', borderRadius: 8, padding: 16 }}>
              <p style={{ margin: '0 0 8px', fontWeight: 600 }}>📹 الـ Short المدخل</p>
              <p style={{ margin: '0 0 8px', fontSize: 13, color: '#555' }}>Video ID: <code>{result.videoId}</code></p>
              {result.thumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result.thumbnailUrl} alt="thumbnail" style={{ width: '100%', maxWidth: 320, borderRadius: 6 }} />
              )}
            </div>
          )}

          {result.matches && result.matches.length === 0 && (
            <div style={{ background: '#f0f0f0', borderRadius: 8, padding: 16, color: '#555' }}>
              😕 لم يتم العثور على مطابقات. جرب رابطاً آخر.
            </div>
          )}

          {result.matches && result.matches.length > 0 && (
            <div>
              <h2 style={{ fontSize: 18, marginBottom: 12 }}>✅ النتائج ({result.matches.length} مطابقة)</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {result.matches.map((m, i) => (
                  <a
                    key={i}
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'block', padding: 14,
                      background: '#fff', border: '1.5px solid #e0e0e0',
                      borderRadius: 8, textDecoration: 'none', color: '#111',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.06)'
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {i + 1}. {m.title || '(بدون عنوان)'}
                    </div>
                    <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{m.source}</div>
                    <div style={{ fontSize: 12, color: '#0070f3', wordBreak: 'break-all' }}>{m.url}</div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  )
}
