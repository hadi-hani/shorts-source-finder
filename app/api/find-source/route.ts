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

function getThumbnailUrls(videoId: string): string[] {
  return ['maxresdefault', 'sddefault', 'hqdefault', '0'].map(
    (q) => `https://i.ytimg.com/vi/${videoId}/${q}.jpg`
  )
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * s-r~google-lens dataset structure (ONE row per image):
 * [
 *   {
 *     image_url: string,
 *     match_count: number,
 *     search_url: string,
 *     matches: [
 *       { title: string, link: string, source: string, thumbnail: string },
 *       ...
 *     ]
 *   }
 * ]
 */
function extractMatchesFromDataset(rows: Array<Record<string, unknown>>): Match[] {
  const results: Match[] = []

  for (const row of rows) {
    // ---- Case 1: nested matches array (s-r~google-lens format) ----
    if (Array.isArray(row['matches'])) {
      for (const m of row['matches'] as Record<string, string>[]) {
        const url = m['link'] || m['url'] || m['pageUrl'] || ''
        if (url) {
          results.push({
            url,
            title: m['title'] || '',
            source: m['source'] || m['domain'] || '',
          })
        }
      }
      continue
    }

    // ---- Case 2: flat item ----
    const url = (row['link'] || row['url'] || row['pageUrl']) as string | undefined
    if (url) {
      results.push({
        url,
        title: (row['title'] as string) || '',
        source: (row['source'] as string) || (row['domain'] as string) || '',
      })
    }
  }

  return results
}

/* ─── Apify async polling ─────────────────────────────── */

async function runApifyAsync(imageUrl: string, token: string): Promise<Match[]> {
  // 1. Start run async
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/s-r~google-lens/runs?token=${token}&memory=1024`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_urls: [imageUrl] }),
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

  // 2. Poll every 5 seconds
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await sleep(5000)

    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`)
    if (!statusRes.ok) continue

    const statusData = await statusRes.json() as {
      data: { status: string; stats?: { itemCount?: number } }
    }
    const runStatus = statusData.data?.status
    const itemCount = statusData.data?.stats?.itemCount ?? 0

    console.log(`[find-source] run=${runId} status=${runStatus} items=${itemCount}`)

    if (itemCount > 0) {
      const dataRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&limit=30`
      )
      if (dataRes.ok) {
        const rows = await dataRes.json() as Array<Record<string, unknown>>
        console.log(`[find-source] raw first row keys: ${Object.keys(rows[0] ?? {}).join(', ')}`)
        const matches = extractMatchesFromDataset(rows)
        console.log(`[find-source] extracted ${matches.length} matches`)
        if (matches.length > 0) return matches
      }
    }

    if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(runStatus)) {
      // Run finished — do a final fetch even if itemCount==0 (stats can lag)
      const dataRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&limit=30`
      )
      if (dataRes.ok) {
        const rows = await dataRes.json() as Array<Record<string, unknown>>
        console.log(`[find-source] final fetch first row keys: ${Object.keys(rows[0] ?? {}).join(', ')}`)
        return extractMatchesFromDataset(rows)
      }
      break
    }
  }

  return []
}

/* ─── SerpApi ─────────────────────────────────────────── */

async function searchWithSerpApi(videoId: string, token: string): Promise<Match[]> {
  for (const thumbUrl of getThumbnailUrls(videoId)) {
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

    const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`

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

    const thumbUrl = getThumbnailUrls(videoId)[2] // hqdefault
    const matches = await runApifyAsync(thumbUrl, apifyToken)
    return NextResponse.json({ videoId, thumbnailUrl, matches })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[find-source]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
