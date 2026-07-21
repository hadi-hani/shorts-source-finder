import { NextRequest, NextResponse } from 'next/server'

// Active Apify actors for Google Lens (ordered by preference)
const APIFY_ACTORS = [
  {
    id: 'borderline~google-lens',
    inputKey: 'imageUrl',
    mapItem: (item: Record<string, string>) => ({
      url: item['url'] || item['link'] || item['pageUrl'] || '',
      title: item['title'] || item['name'] || item['description'] || '',
      source: item['source'] || item['displayLink'] || item['domain'] || '',
    }),
  },
  {
    id: 'newyear~google-reverse-image-search',
    inputKey: 'imageUrl',
    mapItem: (item: Record<string, string>) => ({
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
  actorId: string,
  inputKey: string,
  imageUrl: string,
  token: string
): Promise<Array<Record<string, string>>> {
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=90&memory=256`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [inputKey]: imageUrl, maxResults: 10 }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Apify error ${res.status} [${actorId}]: ${text}`)
  }
  const data = await res.json() as Array<Record<string, string>>
  if (!Array.isArray(data)) return []
  return data
}

async function searchWithApify(
  imageUrl: string,
  token: string
): Promise<Array<{ url: string; title: string; source: string }>> {
  let lastError: Error | null = null

  for (const actor of APIFY_ACTORS) {
    try {
      const data = await runApifyActor(actor.id, actor.inputKey, imageUrl, token)
      const mapped = data.map(actor.mapItem).filter((m) => m.url)
      if (mapped.length > 0) return mapped
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // try next actor
      continue
    }
  }

  if (lastError) throw lastError
  return []
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
    const { url, provider = 'apify' } = body

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
        return NextResponse.json({ videoId, thumbnailUrl, matches: [], note: 'SERPAPI_KEY is not configured.' })
      }
      const matches = await searchWithSerpApi(thumbnailUrl, serpToken)
      return NextResponse.json({ videoId, thumbnailUrl, matches })
    }

    const apifyToken = process.env.APIFY_API_TOKEN
    if (!apifyToken) {
      return NextResponse.json({ videoId, thumbnailUrl, matches: [], note: 'APIFY_API_TOKEN is not configured.' })
    }

    const matches = await searchWithApify(thumbnailUrl, apifyToken)
    return NextResponse.json({ videoId, thumbnailUrl, matches })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[find-source]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
