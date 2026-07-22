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
      if (base64.length > 1000) {
        console.log(`[find-source] fetched thumbnail from ${url} (${base64.length} chars base64)`)
        return base64
      }
    } catch (e) {
      console.warn(`[find-source] thumbnail fetch failed for ${url}:`, e)
    }
  }
  throw new Error('Could not fetch a valid YouTube thumbnail for base64 conversion.')
}

function extractMatchesFromDataset(rows: Array<Record<string, unknown>>): Match[] {
  const results: Match[] = []

  for (const row of rows) {
    // Log all keys for debugging
    console.log(`[find-source] row keys: ${Object.keys(row).join(', ')}`)

    // Try every known key variant the actor might return
    const candidates = [
      row['visual-match'],   // kebab-case — confirmed from logs
      row['visualMatches'],  // camelCase
      row['visualMatch'],
      row['matches'],
      row['results'],
    ]

    let handled = false
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length > 0) {
        for (const m of candidate as Record<string, string>[]) {
          const url = m['link'] || m['url'] || m['pageUrl'] || ''
          if (url) results.push({
            url,
            title: m['title'] || m['name'] || '',
            source: m['source'] || m['domain'] || m['siteName'] || '',
          })
        }
        handled = true
        break
      }
    }

    if (!handled) {
      // Flat item fallback
      const url = (row['link'] || row['url'] || row['pageUrl']) as string | undefined
      if (url) results.push({
        url,
        title: (row['title'] as string) || '',
        source: (row['source'] as string) || (row['domain'] as string) || '',
      })
    }
  }

  return results
}

/* ─── Apify async polling ─────────────────────────────── */

async function runApifyAsync(videoId: string, token: string): Promise<Match[]> {
  const imageBase64 = await fetchThumbnailAsBase64(videoId)

  const startRes = await fetch(
    `https://api.apify.com/v2/acts/MaNVYRogwHemtywEz/runs?token=${token}&memory=1024`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imagesBase64: [imageBase64],
        searchTypes: ['visual-match'],
      }),
    }
  )

  if (!startRes.ok) {
    const txt = await startRes.text()
    throw new Error(`Apify start error ${startRes.status}: ${txt}`)
  }

  const startData = await startRes.json() as { data: { id: string } }
  const runId = startData.data?.id
  if (!runId) throw new Error('Apify did not return a run ID')

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

    console.log(`[find-source] run=${runId} status=${runStatus} items=${itemCount} dataset=${datasetId}`)

    if (itemCount > 0 && datasetId) {
      // Fetch via dataset ID directly for reliability
      const dataRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=30`
      )
      if (dataRes.ok) {
        const rows = await dataRes.json() as Array<Record<string, unknown>>
        console.log(`[find-source] dataset rows: ${rows.length}, first row keys: ${Object.keys(rows[0] ?? {}).join(', ')}`)
        const matches = extractMatchesFromDataset(rows)
        console.log(`[find-source] extracted ${matches.length} matches`)
        if (matches.length > 0) return matches
      }
    }

    if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(runStatus)) {
      // Final fetch — try both endpoints
      const urls = datasetId
        ? [
            `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=30`,
            `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&limit=30`,
          ]
        : [`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&limit=30`]

      for (const url of urls) {
        const dataRes = await fetch(url)
        if (dataRes.ok) {
          const rows = await dataRes.json() as Array<Record<string, unknown>>
          console.log(`[find-source] final rows: ${rows.length}, keys: ${Object.keys(rows[0] ?? {}).join(', ')}`)
          const matches = extractMatchesFromDataset(rows)
          if (matches.length > 0) return matches
        }
      }
      break
    }
  }

  return []
}

/* ─── SerpApi ─────────────────────────────────────────── */

async function searchWithSerpApi(videoId: string, token: string): Promise<Match[]> {
  const thumbUrls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  ]
  for (const thumbUrl of thumbUrls) {
    const params = new URLSearchParams({ engine: 'google_lens', url: thumbUrl, api_key: token })
    const res = await fetch(`https://serpapi.com/search?${params}`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`SerpApi error ${res.status}: ${await res.text()}`)
    const data = await res.json() as { visual_matches?: Array<Record<string, string>> }
    const matches = (data.visual_matches || [])
      .map((item) => ({ url: item['link'] || item['url'] || '', title: item['title'] || '', source: item['source'] || '' }))
      .filter((m) => m.url)
    if (matches.length > 0) return matches
  }
  return []
}

/* ─── Route handler ───────────────────────────────────── */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { url: string; provider?: string }
    const { url, provider = 'apify' } = body

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Please provide a valid YouTube URL' }, { status: 400 })
    }

    const videoId = extractVideoId(url.trim())
    if (!videoId) {
      return NextResponse.json({ error: 'Could not extract a valid YouTube video ID.' }, { status: 400 })
    }

    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`

    if (provider === 'serpapi') {
      const serpToken = process.env.SERPAPI_KEY
      if (!serpToken) {
        return NextResponse.json({ videoId, thumbnailUrl, matches: [], note: 'SERPAPI_KEY is not configured.' })
      }
      const matches = await searchWithSerpApi(videoId, serpToken)
      return NextResponse.json({ videoId, thumbnailUrl, matches })
    }

    const apifyToken = process.env.APIFY_API_TOKEN
    if (!apifyToken) {
      return NextResponse.json({ videoId, thumbnailUrl, matches: [], note: 'APIFY_API_TOKEN is not configured.' })
    }

    const matches = await runApifyAsync(videoId, apifyToken)
    return NextResponse.json({ videoId, thumbnailUrl, matches })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[find-source]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
