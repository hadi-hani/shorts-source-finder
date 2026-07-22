import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

type Match = { url: string; title: string; source: string; thumbnail?: string }

/* ─── helpers ───────────────────────────────────────────── */

function extractVideoId(inputUrl: string): string | null {
  try {
    const u = new URL(inputUrl)
    if (u.pathname.includes('/shorts/')) {
      const id = u.pathname.split('/shorts/')[1]?.split('/')[0]?.split('?')[0]
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id
    }
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('?')[0]
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id
    }
    const v = u.searchParams.get('v')
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v
    return null
  } catch { return null }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/* ─────────────────────────────────────────────────────────
   STEP 1 — Extract real storyboard frame URLs + base64
   YouTube storyboard URL provides frames at different
   timestamps across the full video duration.
───────────────────────────────────────────────────────── */

/**
 * Get all possible thumbnail/frame URLs for a YouTube video.
 * These cover different moments: cover, frame1, frame2, frame3,
 * plus standard quality variants.
 */
function getAllFrameUrls(videoId: string): string[] {
  return [
    // Main thumbnail variants — different capture moments
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    // Storyboard frames 1,2,3 — beginning / middle / end of video
    `https://img.youtube.com/vi/${videoId}/1.jpg`,
    `https://img.youtube.com/vi/${videoId}/2.jpg`,
    `https://img.youtube.com/vi/${videoId}/3.jpg`,
    // WebP variants (sometimes available)
    `https://img.youtube.com/vi_webp/${videoId}/maxresdefault.webp`,
    `https://img.youtube.com/vi_webp/${videoId}/hqdefault.webp`,
  ]
}

/**
 * Fetch a single frame URL and return it as base64 data URL.
 * Returns null if the image is a grey placeholder (< 5KB).
 */
async function fetchFrameAsBase64(
  url: string
): Promise<{ base64: string; dataUrl: string; url: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      console.log(`[frames] ${url} → HTTP ${res.status}`)
      return null
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg'
    const mimeType = contentType.split(';')[0].trim()
    const buf = await res.arrayBuffer()
    const bytes = buf.byteLength
    // YouTube returns a tiny 120x90 grey placeholder for missing frames (< 5KB)
    if (bytes < 5000) {
      console.log(`[frames] placeholder skipped: ${url} (${bytes} bytes)`)
      return null
    }
    const base64 = Buffer.from(buf).toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`
    console.log(`[frames] ✓ ${url} (${Math.round(bytes / 1024)}KB, ${mimeType})`)
    return { base64, dataUrl, url, mimeType }
  } catch (e) {
    console.warn(`[frames] failed ${url}:`, (e as Error).message)
    return null
  }
}

interface FrameResult {
  base64: string
  dataUrl: string
  url: string
  mimeType: string
}

/**
 * Collect up to `maxFrames` valid frames from a video.
 * Tries all known URLs and returns the first `maxFrames` that pass validation.
 */
async function collectFrames(videoId: string, maxFrames = 5): Promise<FrameResult[]> {
  const urls = getAllFrameUrls(videoId)
  const results: FrameResult[] = []
  const seen = new Set<string>()

  for (const url of urls) {
    if (results.length >= maxFrames) break
    const frame = await fetchFrameAsBase64(url)
    if (frame && !seen.has(frame.base64.slice(0, 100))) {
      seen.add(frame.base64.slice(0, 100))
      results.push(frame)
    }
  }

  console.log(`[frames] collected ${results.length}/${maxFrames} frames for videoId=${videoId}`)
  return results
}

/* ─────────────────────────────────────────────────────────
   STEP 2A — Apify: Google Reverse Image Search
   Actor: MaNVYRogwHemtywEz
   We try multiple input schemas because different actor
   versions accept different field names.
───────────────────────────────────────────────────────── */

function extractMatchesFromDataset(rows: Array<Record<string, unknown>>): Match[] {
  const results: Match[] = []

  for (const row of rows) {
    const keys = Object.keys(row)
    console.log(`[apify] row keys: ${keys.slice(0, 20).join(', ')}`)

    // All possible array keys the actor might use
    const arrayKeys = [
      'visual-match', 'visualMatches', 'visualMatch',
      'matches', 'results', 'items', 'data',
      'pages', 'links', 'relatedImages', 'similar',
    ]

    let handled = false
    for (const key of arrayKeys) {
      const candidate = row[key]
      if (Array.isArray(candidate) && candidate.length > 0) {
        for (const m of candidate as Record<string, string>[]) {
          const url = m['link'] || m['url'] || m['pageUrl'] || m['href'] || ''
          if (url) {
            results.push({
              url,
              title: m['title'] || m['name'] || m['text'] || '',
              source: m['source'] || m['domain'] || m['siteName'] || '',
              thumbnail: m['thumbnail'] || m['image'] || m['imageUrl'] || '',
            })
          }
        }
        handled = true
        break
      }
    }

    if (!handled) {
      const url = (row['link'] || row['url'] || row['pageUrl'] || row['href']) as string | undefined
      if (url) {
        results.push({
          url,
          title: (row['title'] as string) || '',
          source: (row['source'] as string) || (row['domain'] as string) || '',
          thumbnail: (row['thumbnail'] as string) || '',
        })
      }
    }
  }

  return results
}

async function pollApifyRun(
  runId: string,
  token: string,
  timeoutMs = 240_000
): Promise<{ matches: Match[]; rawSample: string }> {
  const deadline = Date.now() + timeoutMs
  let rawSample = ''

  while (Date.now() < deadline) {
    await sleep(6000)

    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`,
      { signal: AbortSignal.timeout(10_000) }
    ).catch(() => null)

    if (!statusRes || !statusRes.ok) {
      console.warn(`[apify] status check failed`)
      continue
    }

    const statusData = await statusRes.json() as {
      data: { status: string; defaultDatasetId?: string; stats?: { itemCount?: number } }
    }

    const runStatus = statusData.data?.status
    const itemCount = statusData.data?.stats?.itemCount ?? 0
    const datasetId = statusData.data?.defaultDatasetId

    console.log(`[apify] run=${runId} status=${runStatus} items=${itemCount} dataset=${datasetId}`)

    if (itemCount > 0 && datasetId) {
      const rows = await fetchDatasetRows(datasetId, token)
      const matches = extractMatchesFromDataset(rows)
      if (matches.length > 0) {
        console.log(`[apify] early exit with ${matches.length} matches`)
        return { matches, rawSample }
      }
    }

    if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(runStatus)) {
      console.log(`[apify] terminal: ${runStatus}`)

      // Fetch from dataset
      const fetchUrls = [
        datasetId
          ? `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=50`
          : null,
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&limit=50`,
      ].filter(Boolean) as string[]

      for (const fetchUrl of fetchUrls) {
        const rows = await fetchDatasetRows(undefined, token, fetchUrl)
        // Capture raw for debugging
        if (rows.length > 0 && !rawSample) {
          rawSample = JSON.stringify(rows.slice(0, 2)).slice(0, 1000)
          console.log(`[apify] raw sample: ${rawSample}`)
        }
        const matches = extractMatchesFromDataset(rows)
        if (matches.length > 0) return { matches, rawSample }
      }

      break
    }
  }

  return { matches: [], rawSample }
}

async function fetchDatasetRows(
  datasetId: string | undefined,
  token: string,
  overrideUrl?: string
): Promise<Array<Record<string, unknown>>> {
  const url =
    overrideUrl ||
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=50`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return []
    return (await res.json()) as Array<Record<string, unknown>>
  } catch {
    return []
  }
}

/**
 * Try multiple input schemas for Apify actor MaNVYRogwHemtywEz.
 * Different builds of this actor accept different field names.
 */
async function runApifyWithFrames(
  videoId: string,
  token: string,
  frames: FrameResult[]
): Promise<{ matches: Match[]; method: string; rawSample: string }> {
  if (frames.length === 0) {
    console.error('[apify] no frames available')
    return { matches: [], method: 'apify-noframes', rawSample: '' }
  }

  const imageUrls = frames.map((f) => f.url)
  const imagesBase64 = frames.map((f) => f.base64)
  // Some actor versions want full data URLs
  const imagesDataUrl = frames.map((f) => f.dataUrl)

  // Schema variants to try — ordered by most likely to work
  const schemas = [
    // Schema A: standard field names
    { imagesBase64, imageUrls, searchTypes: ['visual-match'], maxResults: 20 },
    // Schema B: only URLs (no base64) — some versions reject base64
    { imageUrls, searchTypes: ['visual-match'], maxResults: 20 },
    // Schema C: data URLs instead of raw base64
    { imagesBase64: imagesDataUrl, searchTypes: ['visual-match'], maxResults: 20 },
    // Schema D: single image URL, minimal input
    { imageUrl: imageUrls[0], maxResults: 20 },
    // Schema E: "queries" format used by some Google Lens actors
    { queries: imageUrls.map((u) => ({ imageUrl: u })), maxResults: 20 },
    // Schema F: just startUrls with image URL
    { startUrls: [{ url: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrls[0])}` }], maxResults: 20 },
  ]

  for (let i = 0; i < schemas.length; i++) {
    const schema = schemas[i]
    console.log(`[apify] trying schema ${i + 1}/${schemas.length}:`, JSON.stringify(schema).slice(0, 200))

    const startRes = await fetch(
      `https://api.apify.com/v2/acts/MaNVYRogwHemtywEz/runs?token=${token}&memory=2048&timeout=180`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(schema),
        signal: AbortSignal.timeout(30_000),
      }
    ).catch((e) => { console.error('[apify] start error:', e); return null })

    if (!startRes || !startRes.ok) {
      const errText = startRes ? await startRes.text() : 'network error'
      console.error(`[apify] schema ${i + 1} start failed:`, errText.slice(0, 300))
      continue
    }

    const startData = await startRes.json() as { data: { id: string } }
    const runId = startData.data?.id
    if (!runId) {
      console.error('[apify] no run ID')
      continue
    }

    console.log(`[apify] schema ${i + 1} run started: ${runId}`)
    const { matches, rawSample } = await pollApifyRun(runId, token)

    if (matches.length > 0) {
      console.log(`[apify] schema ${i + 1} SUCCESS — ${matches.length} matches`)
      return { matches, method: `apify-schema${i + 1}`, rawSample }
    }

    console.log(`[apify] schema ${i + 1} returned 0 results, trying next schema...`)
  }

  return { matches: [], method: 'apify-all-schemas-failed', rawSample: '' }
}

/* ─────────────────────────────────────────────────────────
   STEP 2B — Apify: Google Lens actor (nwua9Gu5YrADL7ZDj)
   Alternative actor from Apify Store — official Google Lens
   scraper. Uses imageUrl field.
───────────────────────────────────────────────────────── */

async function runApifyGoogleLensActor(
  videoId: string,
  token: string,
  frames: FrameResult[]
): Promise<{ matches: Match[]; method: string; rawSample: string }> {
  const imageUrls = frames.map((f) => f.url)
  if (imageUrls.length === 0) return { matches: [], method: 'apify-lens-noframes', rawSample: '' }

  // Google Lens actor accepts one URL per run — try first 3 frames
  for (let i = 0; i < Math.min(3, imageUrls.length); i++) {
    const imageUrl = imageUrls[i]
    console.log(`[apify-lens] trying frame ${i + 1}: ${imageUrl}`)

    const startRes = await fetch(
      `https://api.apify.com/v2/acts/nwua9Gu5YrADL7ZDj/runs?token=${token}&memory=2048&timeout=180`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl,
          maxResults: 20,
          outputType: 'all',
        }),
        signal: AbortSignal.timeout(30_000),
      }
    ).catch(() => null)

    if (!startRes || !startRes.ok) {
      const err = startRes ? await startRes.text() : 'network error'
      console.error(`[apify-lens] start failed:`, err.slice(0, 200))
      continue
    }

    const startData = await startRes.json() as { data: { id: string } }
    const runId = startData.data?.id
    if (!runId) continue

    console.log(`[apify-lens] run started: ${runId}`)
    const { matches, rawSample } = await pollApifyRun(runId, token)

    if (matches.length > 0) {
      return { matches, method: 'apify-google-lens', rawSample }
    }
  }

  return { matches: [], method: 'apify-lens-no-results', rawSample: '' }
}

/* ─────────────────────────────────────────────────────────
   STEP 3 — SerpApi Google Lens (reliable)
───────────────────────────────────────────────────────── */

async function searchWithSerpApi(videoId: string, token: string): Promise<Match[]> {
  const thumbUrls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/1.jpg`,
    `https://img.youtube.com/vi/${videoId}/2.jpg`,
    `https://img.youtube.com/vi/${videoId}/3.jpg`,
  ]

  for (const thumbUrl of thumbUrls) {
    try {
      const params = new URLSearchParams({ engine: 'google_lens', url: thumbUrl, api_key: token })
      const res = await fetch(`https://serpapi.com/search?${params}`, {
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) continue
      const data = await res.json() as { visual_matches?: Array<Record<string, string>> }
      const matches = (data.visual_matches || [])
        .map((item) => ({
          url: item['link'] || item['url'] || '',
          title: item['title'] || '',
          source: item['source'] || '',
          thumbnail: item['thumbnail'] || '',
        }))
        .filter((m) => m.url)
      if (matches.length > 0) return matches
    } catch { /* try next */ }
  }

  return []
}

/* ─────────────────────────────────────────────────────────
   Route handler
───────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { url: string; provider?: string }
    const { url, provider } = body

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Please provide a valid YouTube URL' }, { status: 400 })
    }

    const videoId = extractVideoId(url.trim())
    if (!videoId) {
      return NextResponse.json({ error: 'Could not extract a valid YouTube video ID.' }, { status: 400 })
    }

    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    const allFrameUrls = getAllFrameUrls(videoId)
    console.log(`[find-source] videoId=${videoId} provider=${provider || 'auto'}`)

    // ── Collect frames (used by all Apify methods) ────────
    const frames = await collectFrames(videoId, 5)
    const frameUrls = frames.map((f) => f.url)

    // ── Force Apify (primary actor) ───────────────────────
    if (provider === 'apify') {
      const apifyToken = process.env.APIFY_API_TOKEN
      if (!apifyToken) {
        return NextResponse.json(
          { error: 'APIFY_API_TOKEN not configured.' },
          { status: 500 }
        )
      }
      // Try primary actor with all schemas
      const primary = await runApifyWithFrames(videoId, apifyToken, frames)
      if (primary.matches.length > 0) {
        return NextResponse.json({
          videoId, thumbnailUrl, frameUrls, allFrameUrls,
          matches: primary.matches,
          method: primary.method,
        })
      }
      // Try alternative Google Lens actor
      console.log('[find-source] primary actor failed, trying Google Lens actor...')
      const lens = await runApifyGoogleLensActor(videoId, apifyToken, frames)
      return NextResponse.json({
        videoId, thumbnailUrl, frameUrls, allFrameUrls,
        matches: lens.matches,
        method: lens.method,
        apifyDebug: {
          primaryRawSample: primary.rawSample,
          lensRawSample: lens.rawSample,
          framesCollected: frames.length,
          frameUrls,
        },
      })
    }

    // ── Force SerpApi ─────────────────────────────────────
    if (provider === 'serpapi') {
      const serpToken = process.env.SERPAPI_KEY
      if (!serpToken) {
        return NextResponse.json({ error: 'SERPAPI_KEY not configured.' }, { status: 500 })
      }
      const matches = await searchWithSerpApi(videoId, serpToken)
      return NextResponse.json({ videoId, thumbnailUrl, frameUrls, matches, method: 'serpapi' })
    }

    // ── Auto: try Apify first, then SerpApi ──────────────
    const apifyToken = process.env.APIFY_API_TOKEN
    if (apifyToken) {
      console.log('[find-source] auto: trying Apify primary actor...')
      const primary = await runApifyWithFrames(videoId, apifyToken, frames)
      if (primary.matches.length > 0) {
        return NextResponse.json({
          videoId, thumbnailUrl, frameUrls, matches: primary.matches, method: primary.method,
        })
      }
      console.log('[find-source] auto: Apify primary returned 0, trying Google Lens actor...')
      const lens = await runApifyGoogleLensActor(videoId, apifyToken, frames)
      if (lens.matches.length > 0) {
        return NextResponse.json({
          videoId, thumbnailUrl, frameUrls, matches: lens.matches, method: lens.method,
        })
      }
      console.log('[find-source] auto: all Apify actors returned 0, falling back to SerpApi...')
    }

    const serpToken = process.env.SERPAPI_KEY
    if (serpToken) {
      const matches = await searchWithSerpApi(videoId, serpToken)
      if (matches.length > 0) {
        return NextResponse.json({ videoId, thumbnailUrl, frameUrls, matches, method: 'serpapi' })
      }
    }

    return NextResponse.json({
      videoId, thumbnailUrl, frameUrls, allFrameUrls,
      matches: [],
      note: 'No results found. Video may be too new or not indexed.',
    })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[find-source]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
