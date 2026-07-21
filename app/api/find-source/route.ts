import { NextRequest, NextResponse } from 'next/server'

type Match = { url: string; title: string; source: string }

type ApifyActor = {
  id: string
  memory: number
  buildInput: (imageUrl: string) => Record<string, unknown>
  extractMatches: (data: unknown) => Match[]
}

// s-r/google-lens returns: [{ image_url, match_count, matches: [{url,title,source}], search_url }]
function extractSrGoogleLens(data: unknown): Match[] {
  if (!Array.isArray(data)) return []
  const results: Match[] = []
  for (const row of data) {
    const r = row as Record<string, unknown>
    // nested matches array inside each dataset item
    if (Array.isArray(r['matches'])) {
      for (const m of r['matches'] as Record<string, string>[]) {
        const url = m['url'] || m['link'] || m['pageUrl'] || ''
        if (url) results.push({ url, title: m['title'] || '', source: m['source'] || m['domain'] || '' })
      }
    }
    // flat item fallback
    const url = r['url'] as string || r['link'] as string || ''
    if (url && !results.find(x => x.url === url)) {
      results.push({ url, title: r['title'] as string || '', source: r['source'] as string || '' })
    }
  }
  return results
}

// Generic flat array extractor for other actors
function extractFlat(data: unknown): Match[] {
  if (!Array.isArray(data)) return []
  return (data as Record<string, string>[]).map((item) => ({
    url: item['url'] || item['link'] || item['pageUrl'] || '',
    title: item['title'] || item['name'] || item['description'] || '',
    source: item['source'] || item['displayLink'] || item['domain'] || '',
  })).filter((m) => m.url)
}

const APIFY_ACTORS: ApifyActor[] = [
  {
    id: 's-r~google-lens',
    memory: 1024,
    buildInput: (imageUrl) => ({ image_urls: [imageUrl] }),
    extractMatches: extractSrGoogleLens,
  },
  {
    id: 'thodor~google-lens-exact-matches',
    memory: 1024,
    buildInput: (imageUrl) => ({ imageUrl }),
    extractMatches: extractFlat,
  },
  {
    id: 'prodiger~google-lens-scraper',
    memory: 1024,
    buildInput: (imageUrl) => ({ imageUrls: [imageUrl], searchTypes: ['visual-match'] }),
    extractMatches: extractFlat,
  },
  {
    id: 'borderline~google-lens',
    memory: 1024,
    buildInput: (imageUrl) => ({ imageUrls: [{ url: imageUrl }], searchTypes: ['visual-match'] }),
    extractMatches: extractFlat,
  },
]

const THUMBNAIL_QUALITIES = ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault', '0']

function getThumbnailUrls(videoId: string): string[] {
  return THUMBNAIL_QUALITIES.map((q) => `https://i.ytimg.com/vi/${videoId}/${q}.jpg`)
}

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
  } catch {
    return null
  }
}

async function runApifyActor(actor: ApifyActor, imageUrl: string, token: string): Promise<Match[]> {
  const endpoint = `https://api.apify.com/v2/acts/${actor.id}/run-sync-get-dataset-items?token=${token}&timeout=120&memory=${actor.memory}`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(actor.buildInput(imageUrl)),
    signal: AbortSignal.timeout(130_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Apify [${actor.id}] ${res.status}: ${text}`)
  }
  const data = await res.json()
  return actor.extractMatches(data)
}

async function searchWithApify(
  videoId: string,
  token: string
): Promise<{ matches: Match[]; actorUsed: string; thumbnailUsed: string }> {
  const thumbnails = getThumbnailUrls(videoId)

  for (const actor of APIFY_ACTORS) {
    for (const thumbUrl of thumbnails) {
      try {
        const matches = await runApifyActor(actor, thumbUrl, token)
        if (matches.length > 0) {
          return { matches, actorUsed: actor.id, thumbnailUsed: thumbUrl }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isSkippable =
          msg.includes('404') ||
          msg.includes('record-not-found') ||
          msg.includes('actor-is-not-rented') ||
          msg.includes('403') ||
          msg.includes('timeout') ||
          msg.includes('AbortError')
        if (isSkippable) break
      }
    }
  }

  return { matches: [], actorUsed: 'none', thumbnailUsed: thumbnails[0] }
}

async function searchWithSerpApi(
  videoId: string,
  token: string
): Promise<{ matches: Match[]; thumbnailUsed: string }> {
  const thumbnails = getThumbnailUrls(videoId)

  for (const thumbUrl of thumbnails) {
    const params = new URLSearchParams({ engine: 'google_lens', url: thumbUrl, api_key: token })
    const res = await fetch(`https://serpapi.com/search?${params}`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`SerpApi error ${res.status}: ${text}`)
    }
    const data = await res.json() as { visual_matches?: Array<Record<string, string>> }
    const matches = (data.visual_matches || [])
      .map((item) => ({
        url: item['link'] || item['url'] || '',
        title: item['title'] || '',
        source: item['source'] || '',
      }))
      .filter((m) => m.url)
    if (matches.length > 0) return { matches, thumbnailUsed: thumbUrl }
  }

  return { matches: [], thumbnailUsed: thumbnails[0] }
}

export const maxDuration = 150

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { url: string; provider?: string }
    const { url, provider = 'serpapi' } = body

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Please provide a valid YouTube URL' }, { status: 400 })
    }

    const videoId = extractVideoId(url.trim())
    if (!videoId) {
      return NextResponse.json(
        { error: 'Could not extract a valid YouTube video ID. Supported: youtube.com/shorts/ID, youtu.be/ID, youtube.com/watch?v=ID' },
        { status: 400 }
      )
    }

    const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`

    if (provider === 'serpapi') {
      const serpToken = process.env.SERPAPI_KEY
      if (!serpToken) {
        return NextResponse.json({
          videoId, thumbnailUrl, matches: [],
          note: 'SERPAPI_KEY is not configured. Add it in Vercel Environment Variables.',
        })
      }
      const { matches, thumbnailUsed } = await searchWithSerpApi(videoId, serpToken)
      return NextResponse.json({ videoId, thumbnailUrl, matches, thumbnailUsed })
    }

    const apifyToken = process.env.APIFY_API_TOKEN
    if (!apifyToken) {
      return NextResponse.json({
        videoId, thumbnailUrl, matches: [],
        note: 'APIFY_API_TOKEN is not configured. Add it in Vercel Environment Variables.',
      })
    }

    const { matches, actorUsed, thumbnailUsed } = await searchWithApify(videoId, apifyToken)
    return NextResponse.json({ videoId, thumbnailUrl, matches, actorUsed, thumbnailUsed })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[find-source]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
