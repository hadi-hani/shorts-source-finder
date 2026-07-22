import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

type Match = { url: string; title: string; source: string }

/* ─── helpers ─────────────────────────────────────────── */

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
   STEP 1 — Collect multiple frame URLs from YouTube
   YouTube provides storyboard sprites with frames at
   different timestamps. We extract several distinct
   thumbnail/frame URLs to use in reverse-image search.
───────────────────────────────────────────────────────── */

/**
 * YouTube thumbnail variants — each represents a different
 * moment in the video (cover, mid, end frames).
 */
function getFrameUrls(videoId: string): string[] {
  return [
    // Standard thumbnail options — different capture times
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    // Storyboard frames 1, 2, 3 (different moments)
    `https://img.youtube.com/vi/${videoId}/1.jpg`,
    `https://img.youtube.com/vi/${videoId}/2.jpg`,
    `https://img.youtube.com/vi/${videoId}/3.jpg`,
  ]
}

/**
 * Fetch a frame URL and return base64 string.
 * Returns null if the image is invalid (e.g., 120x90 placeholder).
 */
async function fetchFrameAsBase64(url: string): Promise<{ base64: string; url: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    const b64 = Buffer.from(buf).toString('base64')
    // YouTube returns a tiny 120x90 grey placeholder for missing frames
    // Real frames are usually > 5KB
    if (b64.length < 4000) {
      console.log(`[frames] skipped placeholder: ${url}`)
      return null
    }
    console.log(`[frames] fetched ${url} (${Math.round(b64.length / 1024)}KB base64)`)
    return { base64: b64, url }
  } catch (e) {
    console.warn(`[frames] failed ${url}:`, e)
    return null
  }
}

/**
 * Collect up to `maxFrames` valid base64 frames from the video.
 */
async function collectFrames(
  videoId: string,
  maxFrames = 4
): Promise<{ base64: string; url: string }[]> {
  const urls = getFrameUrls(videoId)
  const results: { base64: string; url: string }[] = []

  for (const url of urls) {
    if (results.length >= maxFrames) break
    const frame = await fetchFrameAsBase64(url)
    if (frame) results.push(frame)
  }

  console.log(`[frames] collected ${results.length} valid frames for ${videoId}`)
  return results
}

/* ─────────────────────────────────────────────────────────
   STEP 2 — Apify Google Reverse Image Search
   Actor: MaNVYRogwHemtywEz
   Input: imagesBase64 array + imageUrls array
   We send BOTH base64 frames AND public URLs.
───────────────────────────────────────────────────────── */

function extractMatchesFromDataset(rows: Array<Record<string, unknown>>): Match[] {
  const results: Match[] = []

  for (const row of rows) {
    const allKeys = Object.keys(row)
    console.log(`[apify] row keys: ${allKeys.join(', ')}`)

    // Try every key variant the actor might produce
    const arrayKeys = [
      'visual-match', 'visualMatches', 'visualMatch',
      'matches', 'results', 'items', 'data',
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
              source: m['source'] || m['domain'] || m['siteName'] || new URL(url).hostname,
            })
          }
        }
        handled = true
        break
      }
    }

    if (!handled) {
      // Maybe the row itself IS a match (flat structure)
      const url = (row['link'] || row['url'] || row['pageUrl']) as string | undefined
      if (url) {
        results.push({
          url,
          title: (row['title'] as string) || '',
          source: (row['source'] as string) || (row['domain'] as string) || '',
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
): Promise<Match[]> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await sleep(6000)

    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`,
      { signal: AbortSignal.timeout(10_000) }
    )
    if (!statusRes.ok) {
      console.warn(`[apify] status check failed: ${statusRes.status}`)
      continue
    }

    const statusData = await statusRes.json() as {
      data: {
        status: string
        defaultDatasetId?: string
        stats?: { itemCount?: number }
      }
    }

    const runStatus = statusData.data?.status
    const itemCount = statusData.data?.stats?.itemCount ?? 0
    const datasetId = statusData.data?.defaultDatasetId

    console.log(`[apify] run=${runId} status=${runStatus} items=${itemCount} dataset=${datasetId}`)

    // Try to fetch results as soon as items appear
    if (itemCount > 0 && datasetId) {
      const rows = await fetchDatasetRows(datasetId, token)
      const matches = extractMatchesFromDataset(rows)
      if (matches.length > 0) {
        console.log(`[apify] early exit with ${matches.length} matches`)
        return matches
      }
    }

    // Terminal state — do a final fetch regardless
    if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(runStatus)) {
      console.log(`[apify] run terminal: ${runStatus}`)

      const fetchUrls = [
        datasetId
          ? `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=50`
          : null,
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&limit=50`,
      ].filter(Boolean) as string[]

      for (const fetchUrl of fetchUrls) {
        const rows = await fetchDatasetRows(undefined, token, fetchUrl)
        const matches = extractMatchesFromDataset(rows)
        if (matches.length > 0) return matches
      }

      // Log raw output for debugging
      if (datasetId) {
        try {
          const rawRes = await fetch(
            `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=5`
          )
          const raw = await rawRes.text()
          console.log(`[apify] raw dataset sample: ${raw.slice(0, 500)}`)
        } catch { /* ignore */ }
      }

      break
    }
  }

  return []
}

async function fetchDatasetRows(
  datasetId: string | undefined,
  token: string,
  overrideUrl?: string
): Promise<Array<Record<string, unknown>>> {
  const url = overrideUrl ||
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=50`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return []
    return await res.json() as Array<Record<string, unknown>>
  } catch {
    return []
  }
}

/**
 * Run Apify Google Reverse Image Search actor with:
 * - Multiple frame base64 images
 * - Multiple frame public URLs
 * Both are sent so the actor can try whichever works.
 */
async function runApifyWithFrames(
  videoId: string,
  token: string
): Promise<Match[]> {
  // Collect up to 4 frames as base64
  const frames = await collectFrames(videoId, 4)

  if (frames.length === 0) {
    console.error('[apify] no frames could be fetched — aborting Apify run')
    return []
  }

  const imagesBase64 = frames.map((f) => f.base64)
  // Also send the public URLs as fallback
  const imageUrls = frames.map((f) => f.url)

  console.log(`[apify] starting run with ${frames.length} frames (base64+url)`)

  // Try input format A: base64 array
  const inputA = {
    imagesBase64,
    imageUrls,
    searchTypes: ['visual-match'],
    maxResults: 20,
  }

  const startRes = await fetch(
    `https://api.apify.com/v2/acts/MaNVYRogwHemtywEz/runs?token=${token}&memory=2048&timeout=180`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputA),
      signal: AbortSignal.timeout(30_000),
    }
  )

  if (!startRes.ok) {
    const errText = await startRes.text()
    console.error(`[apify] start failed ${startRes.status}: ${errText}`)
    // Try fallback input format B: URLs only (no base64)
    return runApifyUrlsOnly(videoId, token)
  }

  const startData = await startRes.json() as { data: { id: string } }
  const runId = startData.data?.id
  if (!runId) {
    console.error('[apify] no run ID returned')
    return []
  }

  console.log(`[apify] run started: ${runId}`)
  return pollApifyRun(runId, token)
}

/**
 * Fallback: send only public YouTube thumbnail URLs (no base64).
 * Some actor versions prefer imageUrls over imagesBase64.
 */
async function runApifyUrlsOnly(videoId: string, token: string): Promise<Match[]> {
  const imageUrls = [
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/1.jpg`,
    `https://img.youtube.com/vi/${videoId}/2.jpg`,
  ]

  console.log(`[apify] fallback: sending ${imageUrls.length} public URLs only`)

  const startRes = await fetch(
    `https://api.apify.com/v2/acts/MaNVYRogwHemtywEz/runs?token=${token}&memory=2048&timeout=180`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageUrls,
        searchTypes: ['visual-match'],
        maxResults: 20,
      }),
      signal: AbortSignal.timeout(30_000),
    }
  )

  if (!startRes.ok) {
    const errText = await startRes.text()
    console.error(`[apify] fallback start failed ${startRes.status}: ${errText}`)
    return []
  }

  const startData = await startRes.json() as { data: { id: string } }
  const runId = startData.data?.id
  if (!runId) return []

  console.log(`[apify] fallback run started: ${runId}`)
  return pollApifyRun(runId, token)
}

/* ─────────────────────────────────────────────────────────
   STEP 3 — SerpApi Google Lens (reliable fallback)
───────────────────────────────────────────────────────── */

async function searchWithSerpApi(videoId: string, token: string): Promise<Match[]> {
  const thumbUrls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/1.jpg`,
    `https://img.youtube.com/vi/${videoId}/2.jpg`,
    `https://img.youtube.com/vi/${videoId}/3.jpg`,
  ]

  const allMatches: Match[] = []

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
        }))
        .filter((m) => m.url)
      if (matches.length > 0) {
        allMatches.push(...matches)
        // Got results from one frame — enough
        break
      }
    } catch { /* try next */ }
  }

  return allMatches
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
    console.log(`[find-source] Processing videoId=${videoId} provider=${provider || 'auto'}`)

    // Collect frames info for response
    const frameUrls = getFrameUrls(videoId)

    // ── Force Apify if provider=apify ──────────────────────
    if (provider === 'apify') {
      const apifyToken = process.env.APIFY_API_TOKEN
      if (!apifyToken) {
        return NextResponse.json({ error: 'APIFY_API_TOKEN is not configured in environment.' }, { status: 500 })
      }
      const matches = await runApifyWithFrames(videoId, apifyToken)
      return NextResponse.json({ videoId, thumbnailUrl, frameUrls, matches, method: 'apify' })
    }

    // ── Force SerpApi if provider=serpapi ──────────────────
    if (provider === 'serpapi') {
      const serpToken = process.env.SERPAPI_KEY
      if (!serpToken) {
        return NextResponse.json({ error: 'SERPAPI_KEY is not configured in environment.' }, { status: 500 })
      }
      const matches = await searchWithSerpApi(videoId, serpToken)
      return NextResponse.json({ videoId, thumbnailUrl, frameUrls, matches, method: 'serpapi' })
    }

    // ── Auto mode: try Apify first, then SerpApi ──────────
    const apifyToken = process.env.APIFY_API_TOKEN
    if (apifyToken) {
      console.log('[find-source] trying Apify...')
      const matches = await runApifyWithFrames(videoId, apifyToken)
      if (matches.length > 0) {
        return NextResponse.json({ videoId, thumbnailUrl, frameUrls, matches, method: 'apify' })
      }
      console.log('[find-source] Apify returned 0 results, falling back to SerpApi')
    }

    const serpToken = process.env.SERPAPI_KEY
    if (serpToken) {
      console.log('[find-source] trying SerpApi...')
      const matches = await searchWithSerpApi(videoId, serpToken)
      if (matches.length > 0) {
        return NextResponse.json({ videoId, thumbnailUrl, frameUrls, matches, method: 'serpapi' })
      }
    }

    return NextResponse.json({
      videoId,
      thumbnailUrl,
      frameUrls,
      matches: [],
      note: 'No results found. The video may be too new, private, or not indexed.',
    })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[find-source]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
