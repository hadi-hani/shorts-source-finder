import { NextRequest, NextResponse } from 'next/server'

type ApifyActor = {
  id: string
  buildInput: (imageUrl: string) => Record<string, unknown>
  mapItem: (item: Record<string, string>) => { url: string; title: string; source: string }
}

// Each actor has a different input schema — defined explicitly per actor
const APIFY_ACTORS: ApifyActor[] = [
  {
    // https://apify.com/s-r/google-lens — input: { image_urls: string[] }
    id: 's-r~google-lens',
    buildInput: (imageUrl) => ({ image_urls: [imageUrl] }),
    mapItem: (item) => ({
      url: item['url'] || item['link'] || item['pageUrl'] || '',
      title: item['title'] || item['name'] || item['description'] || '',
      source: item['source'] || item['displayLink'] || item['domain'] || '',
    }),
  },
  {
    // https://apify.com/thodor/google-lens-exact-matches — input: { imageUrl: string }
    id: 'thodor~google-lens-exact-matches',
    buildInput: (imageUrl) => ({ imageUrl }),
    mapItem: (item) => ({
      url: item['url'] || item['link'] || item['pageUrl'] || '',
      title: item['title'] || item['name'] || item['description'] || '',
      source: item['source'] || item['displayLink'] || item['domain'] || '',
    }),
  },
  {
    // https://apify.com/prodiger/google-lens-scraper — input: { imageUrls: string[], searchTypes: string[] }
    id: 'prodiger~google-lens-scraper',
    buildInput: (imageUrl) => ({ imageUrls: [imageUrl], searchTypes: ['visual-match'] }),
    mapItem: (item) => ({
      url: item['url'] || item['link'] || item['pageUrl'] || '',
      title: item['title'] || item['name'] || item['description'] || '',
      source: item['source'] || item['displayLink'] || item['domain'] || '',
    }),
  },
  {
    // https://apify.com/borderline/google-lens — input: { imageUrls: { url: string }[], searchTypes: string[] }
    id: 'borderline~google-lens',
    buildInput: (imageUrl) => ({ imageUrls: [{ url: imageUrl }], searchTypes: ['visual-match'] }),
    mapItem: (item) => ({
      url: item['url'] || item['link'] || item['pageUrl'] || '',
      title: item['title'] || item['name'] || item['description'] || '',
      source: item['source'] || item['displayLink'] || item['domain'] || '',
    }),
  },
]

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
  return data.map(actor.mapItem).filter((m) => m.url)
}

async function searchWithApify(
  imageUrl: string,
  token: string
): Promise<{ matches: Array<{ url: string; title: string; source: string }>; actorUsed: string }> {
  let lastError = ''

  for (const actor of APIFY_ACTORS) {
    try {
      const matches = await runApifyActor(actor, imageUrl, token)
      return { matches, actorUsed: actor.id }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      const isSkippable =
        lastError.includes('404') ||
        lastError.includes('record-not-found') ||
        lastError.includes('actor-is-not-rented') ||
        lastError.includes('403')
      if (isSkippable) continue
      throw new Error(lastError)
    }
  }

  throw new Error(`All Apify actors failed. Last error: ${lastError}`)
}

async function searchWithSerpApi(
  imageUrl: string,
  token: string
): Promise<Array<{ url: string; title: string; source: string }>> {
  const params = new URLSearchParams({
    engine: 'google_lens',
    url: imageUrl,
    api_key: token,
  })
  const res = await fetch(`https://serpapi.com/search?${params}`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`SerpApi error ${res.status}: ${text}`)
  }
  const data = await res.json() as { visual_matches?: Array<Record<string, string>> }
  return (data.visual_matches || [])
    .map((item) => ({
      url: item['link'] || item['url'] || '',
      title: item['title'] || '',
      source: item['source'] || '',
    }))
    .filter((m) => m.url)
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { url: string; provider?: string }
    const { url, provider = 'serpapi' } = body

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Please provide a valid YouTube Shorts URL' }, { status: 400 })
    }

    const videoId = extractVideoId(url.trim())
    if (!videoId) {
      return NextResponse.json(
        { error: 'Could not extract a valid YouTube video ID. Use a URL like https://youtube.com/shorts/VIDEO_ID' },
        { status: 400 }
      )
    }

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
      const matches = await searchWithSerpApi(thumbnailUrl, serpToken)
      return NextResponse.json({ videoId, thumbnailUrl, matches })
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

    const { matches, actorUsed } = await searchWithApify(thumbnailUrl, apifyToken)
    return NextResponse.json({ videoId, thumbnailUrl, matches, actorUsed })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[find-source]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
