import { NextRequest, NextResponse } from 'next/server'

type ApifyActor = {
  id: string
  buildInput: (imageUrl: string) => Record<string, unknown>
  mapItem: (item: Record<string, string>) => { url: string; title: string; source: string }
}

const APIFY_ACTORS: ApifyActor[] = [
  {
    id: 's-r~google-lens',
    buildInput: (imageUrl) => ({ image_urls: [imageUrl] }),
    mapItem: (item) => ({
      url: item['url'] || item['link'] || item['pageUrl'] || '',
      title: item['title'] || item['name'] || item['description'] || '',
      source: item['source'] || item['displayLink'] || item['domain'] || '',
    }),
  },
  {
    id: 'thodor~google-lens-exact-matches',
    buildInput: (imageUrl) => ({ imageUrl }),
    mapItem: (item) => ({
      url: item['url'] || item['link'] || item['pageUrl'] || '',
      title: item['title'] || item['name'] || item['description'] || '',
      source: item['source'] || item['displayLink'] || item['domain'] || '',
    }),
  },
  {
    id: 'prodiger~google-lens-scraper',
    buildInput: (imageUrl) => ({ imageUrls: [imageUrl], searchTypes: ['visual-match'] }),
    mapItem: (item) => ({
      url: item['url'] || item['link'] || item['pageUrl'] || '',
      title: item['title'] || item['name'] || item['description'] || '',
      source: item['source'] || item['displayLink'] || item['domain'] || '',
    }),
  },
  {
    id: 'borderline~google-lens',
    buildInput: (imageUrl) => ({ imageUrls: [{ url: imageUrl }], searchTypes: ['visual-match'] }),
    mapItem: (item) => ({
      url: item['url'] || item['link'] || item['pageUrl'] || '',
      title: item['title'] || item['name'] || item['description'] || '',
      source: item['source'] || item['displayLink'] || item['domain'] || '',
    }),
  },
]

// YouTube thumbnail qualities to try in order (best → fallback)
const THUMBNAIL_QUALITIES = [
  'maxresdefault',
  'sddefault',
  'hqdefault',
  'mqdefault',
  '0',
]

function getThumbnailUrls(videoId: string): string[] {
  return THUMBNAIL_QUALITIES.map(
    (q) => `https://i.ytimg.com/vi/${videoId}/${q}.jpg`
  )
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

async function runApifyActor(
  actor: ApifyActor,
  imageUrl: string,
  token: string
): Promise<Array<{ url: string; title: string; source: string }>> {
  const endpoint = `https://api.apify.com/v2/acts/${actor.id}/run-sync-get-dataset-items?token=${token}&timeout=90&memory=256`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(actor.buildInput(imageUrl)),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Apify [${actor.id}] ${res.status}: ${text}`)
  }
  const data = await res.json() as Array<Record<string, string>>
  if (!Array.isArray(data)) return []
  return data.map(actor.mapItem).filter((m) => m.url && m.url.length > 0)
}

async function searchWithApify(
  videoId: string,
  token: string
): Promise<{ matches: Array<{ url: string; title: string; source: string }>; actorUsed: string; thumbnailUsed: string }> {
  const thumbnails = getThumbnailUrls(videoId)

  for (const actor of APIFY_ACTORS) {
    for (const thumbUrl of thumbnails) {
      try {
        const matches = await runApifyActor(actor, thumbUrl, token)
        if (matches.length > 0) {
          return { matches, actorUsed: actor.id, thumbnailUsed: thumbUrl }
        }
        // Got empty results — try next thumbnail quality
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isSkippable =
          msg.includes('404') ||
          msg.includes('record-not-found') ||
          msg.includes('actor-is-not-rented') ||
          msg.includes('403')
        if (isSkippable) break // skip all thumbnails for this actor
        // non-fatal error (e.g. invalid-input) — try next thumbnail
      }
    }
  }

  return { matches: [], actorUsed: 'none', thumbnailUsed: thumbnails[0] }
}

async function searchWithSerpApi(
  videoId: string,
  token: string
): Promise<{ matches: Array<{ url: string; title: string; source: string }>; thumbnailUsed: string }> {
  const thumbnails = getThumbnailUrls(videoId)

  for (const thumbUrl of thumbnails) {
    const params = new URLSearchParams({
      engine: 'google_lens',
      url: thumbUrl,
      api_key: token,
    })
    const res = await fetch(`https://serpapi.com/search?${params}`)
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

    if (matches.length > 0) {
      return { matches, thumbnailUsed: thumbUrl }
    }
  }

  return { matches: [], thumbnailUsed: thumbnails[0] }
}

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
        { error: 'Could not extract a valid YouTube video ID. Supported formats: youtube.com/shorts/ID, youtu.be/ID, youtube.com/watch?v=ID' },
        { status: 400 }
      )
    }

    // Show the best available thumbnail in the UI
    const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`

    if (provider === 'serpapi') {
      const serpToken = process.env.SERPAPI_KEY
      if (!serpToken) {
        return NextResponse.json({
          videoId,
          thumbnailUrl,
          matches: [],
          note: 'SERPAPI_KEY is not configured. Add it in Vercel Environment Variables.',
        })
      }
      const { matches, thumbnailUsed } = await searchWithSerpApi(videoId, serpToken)
      return NextResponse.json({ videoId, thumbnailUrl, matches, thumbnailUsed })
    }

    // provider === 'apify'
    const apifyToken = process.env.APIFY_API_TOKEN
    if (!apifyToken) {
      return NextResponse.json({
        videoId,
        thumbnailUrl,
        matches: [],
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
