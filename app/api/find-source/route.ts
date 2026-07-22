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

/* ─── Method 1: YouTube oEmbed (free, no API key needed) ─ */

async function getYouTubeOEmbed(videoId: string): Promise<Match[]> {
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`
    const res = await fetch(oEmbedUrl, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      console.log(`[find-source] oEmbed failed: ${res.status}`)
      return []
    }
    const data = await res.json() as {
      title?: string
      author_name?: string
      author_url?: string
      thumbnail_url?: string
    }
    if (data.title) {
      console.log(`[find-source] oEmbed success: "${data.title}" by ${data.author_name}`)
      return [{
        url: videoUrl,
        title: data.title,
        source: data.author_name || 'YouTube',
      }]
    }
    return []
  } catch (e) {
    console.warn('[find-source] oEmbed error:', e)
    return []
  }
}

/* ─── Method 2: YouTube Data API v3 (if key available) ─── */

async function getYouTubeDataAPI(videoId: string, apiKey: string): Promise<Match[]> {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      console.log(`[find-source] YouTube Data API failed: ${res.status}`)
      return []
    }
    const data = await res.json() as {
      items?: Array<{
        snippet?: {
          title?: string
          channelTitle?: string
          description?: string
        }
      }>
    }
    const item = data.items?.[0]
    if (item?.snippet?.title) {
      console.log(`[find-source] YouTube Data API success: "${item.snippet.title}"`)
      return [{
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: item.snippet.title,
        source: item.snippet.channelTitle || 'YouTube',
      }]
    }
    return []
  } catch (e) {
    console.warn('[find-source] YouTube Data API error:', e)
    return []
  }
}

/* ─── Method 3: SerpApi Google Lens (reverse image) ──── */

async function searchWithSerpApi(videoId: string, token: string): Promise<Match[]> {
  const thumbUrls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  ]
  for (const thumbUrl of thumbUrls) {
    try {
      const params = new URLSearchParams({ engine: 'google_lens', url: thumbUrl, api_key: token })
      const res = await fetch(`https://serpapi.com/search?${params}`, {
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        console.log(`[find-source] SerpApi error ${res.status}`)
        continue
      }
      const data = await res.json() as { visual_matches?: Array<Record<string, string>> }
      const matches = (data.visual_matches || [])
        .map((item) => ({
          url: item['link'] || item['url'] || '',
          title: item['title'] || '',
          source: item['source'] || '',
        }))
        .filter((m) => m.url)
      if (matches.length > 0) {
        console.log(`[find-source] SerpApi found ${matches.length} visual matches`)
        return matches
      }
    } catch (e) {
      console.warn('[find-source] SerpApi attempt failed:', e)
    }
  }
  return []
}

/* ─── Method 4: Apify Google Lens actor (fallback) ──── */

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchThumbnailAsBase64(videoId: string): Promise<string> {
  const candidates = [
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/default.jpg`,
  ]
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) continue
      const arrayBuffer = await res.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString('base64')
      if (base64.length > 1000) return base64
    } catch { /* try next */ }
  }
  throw new Error('Could not fetch YouTube thumbnail')
}

function extractMatchesFromDataset(rows: Array<Record<string, unknown>>): Match[] {
  const results: Match[] = []
  for (const row of rows) {
    const candidates = [
      row['visual-match'],
      row['visualMatches'],
      row['visualMatch'],
      row['matches'],
      row['results'],
    ]
    let handled = false
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length > 0) {
        for (const m of candidate as Record<string, string>[]) {
          const url = m['link'] || m['url'] || m['pageUrl'] || ''
          if (url) results.push({ url, title: m['title'] || '', source: m['source'] || m['domain'] || '' })
        }
        handled = true
        break
      }
    }
    if (!handled) {
      const url = (row['link'] || row['url'] || row['pageUrl']) as string | undefined
      if (url) results.push({ url, title: (row['title'] as string) || '', source: (row['source'] as string) || '' })
    }
  }
  return results
}

async function runApifyAsync(videoId: string, token: string): Promise<Match[]> {
  try {
    const imageBase64 = await fetchThumbnailAsBase64(videoId)
    const startRes = await fetch(
      `https://api.apify.com/v2/acts/MaNVYRogwHemtywEz/runs?token=${token}&memory=1024`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagesBase64: [imageBase64], searchTypes: ['visual-match'] }),
      }
    )
    if (!startRes.ok) return []
    const startData = await startRes.json() as { data: { id: string } }
    const runId = startData.data?.id
    if (!runId) return []
    console.log(`[find-source] Apify run started: ${runId}`)
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      await sleep(5000)
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`)
      if (!statusRes.ok) continue
      const statusData = await statusRes.json() as {
        data: { status: string; defaultDatasetId?: string; stats?: { itemCount?: number } }
      }
      const runStatus = statusData.data?.status
      const itemCount = statusData.data?.stats?.itemCount ?? 0
      const datasetId = statusData.data?.defaultDatasetId
      console.log(`[find-source] run=${runId} status=${runStatus} items=${itemCount}`)
      if (itemCount > 0 && datasetId) {
        const dataRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=30`)
        if (dataRes.ok) {
          const rows = await dataRes.json() as Array<Record<string, unknown>>
          const matches = extractMatchesFromDataset(rows)
          if (matches.length > 0) return matches
        }
      }
      if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(runStatus)) break
    }
    return []
  } catch (e) {
    console.warn('[find-source] Apify error:', e)
    return []
  }
}

/* ─── Route handler ───────────────────────────────────── */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { url: string; provider?: string }
    const { url } = body

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Please provide a valid YouTube URL' }, { status: 400 })
    }

    const videoId = extractVideoId(url.trim())
    if (!videoId) {
      return NextResponse.json({ error: 'Could not extract a valid YouTube video ID.' }, { status: 400 })
    }

    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    console.log(`[find-source] Processing videoId: ${videoId}`)

    // ── Step 1: YouTube oEmbed (free, instant, no key needed) ──
    const oEmbedMatches = await getYouTubeOEmbed(videoId)
    if (oEmbedMatches.length > 0) {
      return NextResponse.json({ videoId, thumbnailUrl, matches: oEmbedMatches, method: 'youtube-oembed' })
    }

    // ── Step 2: YouTube Data API v3 (if YOUTUBE_API_KEY is set) ──
    const ytKey = process.env.YOUTUBE_API_KEY
    if (ytKey) {
      const ytMatches = await getYouTubeDataAPI(videoId, ytKey)
      if (ytMatches.length > 0) {
        return NextResponse.json({ videoId, thumbnailUrl, matches: ytMatches, method: 'youtube-data-api' })
      }
    }

    // ── Step 3: SerpApi Google Lens (if SERPAPI_KEY is set) ──
    const serpToken = process.env.SERPAPI_KEY
    if (serpToken) {
      const serpMatches = await searchWithSerpApi(videoId, serpToken)
      if (serpMatches.length > 0) {
        return NextResponse.json({ videoId, thumbnailUrl, matches: serpMatches, method: 'serpapi' })
      }
    }

    // ── Step 4: Apify Google Lens (if APIFY_API_TOKEN is set) ──
    const apifyToken = process.env.APIFY_API_TOKEN
    if (apifyToken) {
      const apifyMatches = await runApifyAsync(videoId, apifyToken)
      if (apifyMatches.length > 0) {
        return NextResponse.json({ videoId, thumbnailUrl, matches: apifyMatches, method: 'apify' })
      }
    }

    return NextResponse.json({ videoId, thumbnailUrl, matches: [], note: 'No results found. The video may be private or not indexed.' })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[find-source]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
