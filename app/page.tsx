'use client'

import { useState, useRef } from 'react'

// ─── TYPES ────────────────────────────────────────────────────────────────────

type Provider = 'serpapi' | 'apify'

type AppState =
  | 'idle'
  | 'extracting_frames'
  | 'analyzing_frames'
  | 'searching_provider'
  | 'ranking_results'
  | 'success'
  | 'invalid_url'
  | 'provider_key_missing'
  | 'no_good_frame_found'
  | 'no_likely_source_found'
  | 'error'

interface FrameScore {
  url: string
  score: number
  reason: string
  textCount: number
}

interface UnifiedMatch {
  title: string
  url: string
  domain: string
  matchType: 'visual_match' | 'exact_match' | 'similar'
  sourceScore: number
  thumbnail?: string
}

interface ApiResult {
  provider: string
  selectedFrame: string
  frameScores: { frame: { url: string }; score: number; reason: string; textAnnotationsCount: number }[]
  matches: UnifiedMatch[]
  topCandidate: UnifiedMatch | null
  method: string
  // error states
  error?: string
  frames?: FrameScore[]
}

// ─── STATUS MESSAGES ─────────────────────────────────────────────────────────

const STATE_LABELS: Record<string, string> = {
  extracting_frames: 'استخراج الفريمات...',
  analyzing_frames: 'تحليل الفريمات بـ Google Vision...',
  searching_provider: 'البحث العكسي عن المصدر...',
  ranking_results: 'ترتيب النتائج...',
}

// ─── MATCH TYPE LABEL ────────────────────────────────────────────────────────

function matchLabel(type: string) {
  if (type === 'exact_match') return { label: 'تطابق دقيق', color: '#4dbb77' }
  return { label: 'تطابق بصري', color: '#4d9bbb' }
}

// ─── SCORE BAR ───────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const color = score >= 0.6 ? '#4dbb77' : score >= 0.35 ? '#e8a048' : '#bb4d4d'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <div style={{
        flex: 1, height: '4px', background: '#1e1e1e', borderRadius: '2px', overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: color, borderRadius: '2px',
          transition: 'width 0.6s ease',
        }} />
      </div>
      <span style={{ color, fontSize: '11px', fontWeight: 600, minWidth: '32px' }}>{pct}%</span>
    </div>
  )
}

// ─── ERROR MESSAGE MAP ───────────────────────────────────────────────────────

function ErrorMessage({ code, provider }: { code: string; provider?: string }) {
  const map: Record<string, string> = {
    invalid_url: 'الرابط غير صالح. تأكد أنه رابط YouTube Shorts صحيح.',
    provider_key_missing: `مفتاح ${provider === 'serpapi' ? 'SERPAPI_KEY' : 'APIFY_API_TOKEN'} غير مضبوط في متغيرات البيئة.`,
    no_good_frame_found: 'لم يتم العثور على فريمات صالحة. تأكد أن الفيديو عام.',
    no_likely_source_found: 'البحث العكسي لم يُعد نتائج. جرّب مزوّداً آخر أو فيديو آخر.',
  }
  return (
    <div style={{
      padding: '12px 16px', borderRadius: '10px',
      background: '#180808', border: '1px solid #6b2222',
      color: '#ff8888', fontSize: '13px', lineHeight: 1.5,
    }}>
      {map[code] || `خطأ: ${code}`}
    </div>
  )
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function Home() {
  const [url, setUrl] = useState('')
  const [provider, setProvider] = useState<Provider>('serpapi')
  const [appState, setAppState] = useState<AppState>('idle')
  const [result, setResult] = useState<ApiResult | null>(null)
  const [errorCode, setErrorCode] = useState<string>('')
  const [errorProvider, setErrorProvider] = useState<string>('')
  const abortRef = useRef<AbortController | null>(null)

  const isLoading = ['extracting_frames', 'analyzing_frames', 'searching_provider', 'ranking_results'].includes(appState)

  // Simulate step progression while waiting for the single API call
  const simulateProgress = () => {
    const steps: AppState[] = ['extracting_frames', 'analyzing_frames', 'searching_provider', 'ranking_results']
    const delays = [0, 3000, 8000, 15000]
    steps.forEach((step, i) => {
      setTimeout(() => {
        setAppState((curr) => {
          if (['idle', 'success', 'error', 'invalid_url', 'provider_key_missing',
            'no_good_frame_found', 'no_likely_source_found'].includes(curr)) return curr
          return step
        })
      }, delays[i])
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return

    // Basic URL check client-side
    if (!trimmed.includes('youtube.com') && !trimmed.includes('youtu.be')) {
      setAppState('invalid_url')
      setErrorCode('invalid_url')
      return
    }

    setResult(null)
    setErrorCode('')
    setErrorProvider('')
    simulateProgress()

    abortRef.current = new AbortController()

    try {
      const res = await fetch('/api/find-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed, provider }),
        signal: abortRef.current.signal,
      })

      const data: ApiResult = await res.json()

      if (data.error) {
        const errCode = data.error
        if (errCode === 'invalid_url') setAppState('invalid_url')
        else if (errCode === 'provider_key_missing') { setAppState('provider_key_missing'); setErrorProvider((data as { provider?: string }).provider || provider) }
        else if (errCode === 'no_good_frame_found') setAppState('no_good_frame_found')
        else if (errCode === 'no_likely_source_found') { setAppState('no_likely_source_found'); setResult(data) }
        else { setAppState('error') }
        setErrorCode(errCode)
        return
      }

      setResult(data)
      setAppState('success')
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setAppState('error')
      setErrorCode('network_error')
    }
  }

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main style={{
      minHeight: '100vh', background: '#0c0c0c', color: '#d8d8d8',
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 16px 80px',
    }}>
      <div style={{ width: '100%', maxWidth: '680px' }}>

        {/* ── Header ── */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '48px', height: '48px', borderRadius: '12px',
            background: '#181818', border: '1px solid #252525',
            fontSize: '22px', marginBottom: '16px',
          }}>🔍</div>
          <h1 style={{ fontSize: '20px', fontWeight: 700, color: '#f0f0f0', margin: '0 0 6px' }}>
            Shorts Source Finder
          </h1>
          <p style={{ fontSize: '13px', color: '#555', margin: 0 }}>
            اعثر على المصدر الأصلي لفيديو YouTube Shorts معاد تغليفه
          </p>
        </div>

        {/* ── Input Card ── */}
        <div style={{
          background: '#131313', border: '1px solid #1f1f1f',
          borderRadius: '14px', padding: '20px', marginBottom: '16px',
        }}>
          <form onSubmit={handleSubmit}>

            {/* URL Input */}
            <label style={{ display: 'block', fontSize: '11px', color: '#555', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '7px' }}>
              رابط YouTube Shorts
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/shorts/xxxxxxxxxx"
              dir="ltr"
              disabled={isLoading}
              style={{
                width: '100%', padding: '11px 14px', borderRadius: '8px',
                border: '1px solid #232323', background: '#0c0c0c',
                color: '#e8e8e8', fontSize: '13px', outline: 'none',
                boxSizing: 'border-box', fontFamily: 'monospace',
                opacity: isLoading ? 0.5 : 1,
              }}
            />

            {/* Provider selector */}
            <label style={{ display: 'block', fontSize: '11px', color: '#555', letterSpacing: '0.08em', textTransform: 'uppercase', margin: '16px 0 7px' }}>
              المزوّد
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {(['serpapi', 'apify'] as Provider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={isLoading}
                  onClick={() => setProvider(p)}
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: '8px',
                    border: `1px solid ${provider === p ? '#3a5a3a' : '#1f1f1f'}`,
                    background: provider === p ? '#1a2a1a' : '#111',
                    color: provider === p ? '#7dcc8d' : '#555',
                    fontSize: '13px', fontWeight: provider === p ? 600 : 400,
                    cursor: isLoading ? 'not-allowed' : 'pointer',
                    transition: 'all 180ms',
                  }}
                >
                  {p === 'serpapi' ? 'SerpApi' : 'Apify'}
                </button>
              ))}
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={isLoading || !url.trim()}
              style={{
                width: '100%', marginTop: '14px', padding: '13px',
                borderRadius: '10px', border: 'none',
                background: isLoading || !url.trim() ? '#181818' : '#1f4d1f',
                color: isLoading || !url.trim() ? '#3a3a3a' : '#7dcc8d',
                fontWeight: 700, fontSize: '14px',
                cursor: isLoading || !url.trim() ? 'not-allowed' : 'pointer',
                transition: 'all 180ms',
              }}
            >
              {isLoading ? STATE_LABELS[appState] || '...' : 'ابحث عن المصدر الأصلي'}
            </button>
          </form>
        </div>

        {/* ── Progress steps (while loading) ── */}
        {isLoading && (
          <div style={{
            background: '#0f0f0f', border: '1px solid #1a1a1a',
            borderRadius: '12px', padding: '16px 20px', marginBottom: '16px',
          }}>
            {(['extracting_frames', 'analyzing_frames', 'searching_provider', 'ranking_results'] as const).map((step) => {
              const steps = ['extracting_frames', 'analyzing_frames', 'searching_provider', 'ranking_results']
              const idx = steps.indexOf(appState)
              const stepIdx = steps.indexOf(step)
              const done = stepIdx < idx
              const active = stepIdx === idx
              return (
                <div key={step} style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '6px 0',
                  opacity: done ? 0.4 : active ? 1 : 0.2,
                }}>
                  <div style={{
                    width: '8px', height: '8px', borderRadius: '50%',
                    background: done ? '#4dbb77' : active ? '#7dcc8d' : '#2a2a2a',
                    flexShrink: 0,
                    boxShadow: active ? '0 0 6px #4dbb77aa' : 'none',
                  }} />
                  <span style={{ fontSize: '13px', color: active ? '#ccc' : '#666' }}>
                    {STATE_LABELS[step]}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Error states ── */}
        {(['invalid_url', 'provider_key_missing', 'no_good_frame_found', 'error'] as AppState[]).includes(appState) && errorCode && (
          <div style={{ marginBottom: '16px' }}>
            <ErrorMessage code={errorCode} provider={errorProvider || provider} />
          </div>
        )}

        {/* ── No source found (show frames) ── */}
        {appState === 'no_likely_source_found' && result && (
          <div style={{ marginBottom: '16px' }}>
            <ErrorMessage code="no_likely_source_found" />
            {result.frames && result.frames.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#444', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '8px' }}>الفريمات المستخدمة</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {result.frames.map((f, i) => (
                    <img key={i} src={f.url} alt={`frame ${i + 1}`}
                      style={{ width: '100px', height: '70px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #222' }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SUCCESS RESULTS ── */}
        {appState === 'success' && result && (
          <div>

            {/* Frames section */}
            <div style={{
              background: '#0f0f0f', border: '1px solid #1a1a1a',
              borderRadius: '12px', padding: '16px 18px', marginBottom: '14px',
            }}>
              <label style={{ display: 'block', fontSize: '11px', color: '#444', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '12px' }}>
                الفريمات المستخرجة
              </label>
              <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '4px' }}>
                {result.frameScores.map((fs, i) => {
                  const isSelected = fs.frame.url === result.selectedFrame
                  return (
                    <div key={i} style={{ flexShrink: 0, position: 'relative' }}>
                      <img
                        src={fs.frame.url}
                        alt={`frame ${i + 1}`}
                        style={{
                          width: '110px', height: '78px', objectFit: 'cover',
                          borderRadius: '7px',
                          border: `2px solid ${isSelected ? '#4dbb77' : '#252525'}`,
                          display: 'block',
                        }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                      {isSelected && (
                        <div style={{
                          position: 'absolute', top: '-7px', right: '-7px',
                          background: '#4dbb77', color: '#000', fontSize: '9px',
                          fontWeight: 700, padding: '2px 5px', borderRadius: '4px',
                        }}>✓ مختار</div>
                      )}
                      <div style={{ fontSize: '10px', color: '#555', marginTop: '4px', textAlign: 'center' }}>
                        {Math.round(fs.score * 100)}%
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Why selected */}
              {result.frameScores.find(fs => fs.frame.url === result.selectedFrame) && (
                <div style={{ marginTop: '10px', fontSize: '12px', color: '#4a4a4a', lineHeight: 1.5 }}>
                  <span style={{ color: '#4dbb77' }}>سبب الاختيار: </span>
                  {result.frameScores.find(fs => fs.frame.url === result.selectedFrame)?.reason}
                </div>
              )}
            </div>

            {/* Provider badge */}
            <div style={{ marginBottom: '12px' }}>
              <span style={{
                display: 'inline-block', padding: '3px 10px', borderRadius: '999px',
                fontSize: '11px', background: '#0d1f0d', color: '#4dbb77', border: '1px solid #1a3a1a',
              }}>
                {result.provider === 'serpapi' ? 'SerpApi — Google Lens' : 'Apify — Google Lens'}
              </span>
            </div>

            {/* Top candidate */}
            {result.topCandidate && (
              <div style={{
                background: '#0f1a0f', border: '1px solid #1e3a1e',
                borderRadius: '12px', padding: '16px 18px', marginBottom: '14px',
              }}>
                <div style={{ fontSize: '11px', color: '#4dbb77', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' }}>
                  ⭐ المصدر الأصلي الأكثر احتمالاً
                </div>
                <a
                  href={result.topCandidate.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: 'none', display: 'block' }}
                >
                  {result.topCandidate.title && (
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#e8e8e8', marginBottom: '4px', lineHeight: 1.4 }}>
                      {result.topCandidate.title}
                    </div>
                  )}
                  <div style={{ fontSize: '12px', color: '#4d9bbb', marginBottom: '6px' }}>
                    {result.topCandidate.domain}
                  </div>
                  <div style={{ fontSize: '11px', color: '#3a3a3a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {result.topCandidate.url}
                  </div>
                </a>
                <div style={{ marginTop: '10px' }}>
                  <ScoreBar score={result.topCandidate.sourceScore} />
                </div>
                <div style={{ marginTop: '6px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <span style={{
                    fontSize: '10px', padding: '2px 8px', borderRadius: '999px',
                    background: '#0d2a1a', color: matchLabel(result.topCandidate.matchType).color,
                    border: `1px solid ${matchLabel(result.topCandidate.matchType).color}33`,
                  }}>
                    {matchLabel(result.topCandidate.matchType).label}
                  </span>
                </div>
              </div>
            )}

            {/* All results */}
            <div style={{ marginBottom: '10px', fontSize: '11px', color: '#444' }}>
              جميع النتائج ({result.matches.length})
            </div>
            {result.matches.map((m, i) => {
              const ml = matchLabel(m.matchType)
              return (
                <a
                  key={i}
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'block', padding: '13px 15px',
                    background: '#111', border: '1px solid #1c1c1c',
                    borderRadius: '10px', textDecoration: 'none',
                    marginBottom: '8px', transition: 'border-color 180ms',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#2a3a2a')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#1c1c1c')}
                >
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                    {m.thumbnail && (
                      <img src={m.thumbnail} alt=""
                        style={{ width: '60px', height: '44px', objectFit: 'cover', borderRadius: '5px', flexShrink: 0, border: '1px solid #1e1e1e' }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                        <span style={{ color: '#3a3a3a', fontSize: '11px', fontWeight: 600 }}>#{i + 1}</span>
                        <span style={{
                          fontSize: '10px', padding: '1px 7px', borderRadius: '999px',
                          background: '#0a1a0a', color: ml.color,
                          border: `1px solid ${ml.color}33`,
                        }}>{ml.label}</span>
                      </div>
                      {m.title && <div style={{ fontSize: '13px', color: '#ccc', fontWeight: 500, marginBottom: '2px', lineHeight: 1.3 }}>{m.title}</div>}
                      <div style={{ fontSize: '11px', color: '#4d9bbb', marginBottom: '4px' }}>{m.domain}</div>
                      <ScoreBar score={m.sourceScore} />
                    </div>
                  </div>
                </a>
              )
            })}

          </div>
        )}

      </div>
    </main>
  )
}
