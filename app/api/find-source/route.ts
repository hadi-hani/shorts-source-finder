import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 300

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface FrameResult {
  url: string
  base64: string
  dataUrl: string
  mimeType: string
}

interface VisionFrameScore {
  frame: FrameResult
  textAnnotationsCount: number
  score: number // higher = better for reverse search
  reason: string
}

export interface UnifiedMatch {
  title: string
  url: string
  domain: string
  matchType: 'visual_match' | 'exact_match' | 'similar'
  sourceScore: number
  thumbnail?: string
  rawRank: number
}

interface ProviderResult {
  provider: 'serpapi' | 'apify'
  selectedFrame: string
  frameScores: VisionFrameScore[]
  matches: UnifiedMatch[]
  topCandidate: UnifiedMatch | null
  method: string
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

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

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch { return '' }
}

// Score a domain for "originality" — penalise aggregators, reward content hosts
function domainOriginScore(domain: string): number {
  const low = ['pinterest', 'tumblr', 'blogspot', 'wordpress.com', 'medium.com',
    'reddit.com', 'quora.com', 'gettyimages', 'shutterstock', 'alamy', 'istockphoto']
  const high = ['youtube.com', 'vimeo.com', 'tiktok.com', 'instagram.com',
    'twitter.com', 'x.com', 'facebook.com', 'dailymotion.com', 'bilibili.com',
    'twitch.tv', 'streamable.com', 'gfycat.com', 'imgur.com']
  if (high.some(d => domain.includes(d))) return 0.3
  if (low.some(d => domain.includes(d))) return -0.2
  return 0
}

// ─── STEP 1 — COLLECT 3 CANDIDATE FRAMES ─────────────────────────────────────
// We use YouTube storyboard frames 1, 2, 3 which correspond to
// beginning (~20%), middle (~50%), end (~80%) of the video.
// Fallback to hqdefault and maxresdefault if storyboard frames are missing.

function getCandidateFrameUrls(videoId: string): string[] {
  return [
    `https://img.youtube.com/vi/${videoId}/1.jpg`,   // ~20%
    `https://img.youtube.com/vi/${videoId}/2.jpg`,   // ~50%
    `https://img.youtube.com/vi/${videoId}/3.jpg`,   // ~80%
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, // fallback
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`, // fallback
  ]
}

async function fetchFrameAsBase64(url: string): Promise<FrameResult | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') || 'image/jpeg'
    const mimeType = contentType.split(';')[0].trim()
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 5000) return null // placeholder
    const base64 = Buffer.from(buf).toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`
    return { url, base64, dataUrl, mimeType }
  } catch { return null }
}

/**
 * Collect exactly 3 unique valid frames (at 20%, 50%, 80%).
 * Falls back to hqdefault/maxresdefault if storyboard frames unavailable.
 */
async function collectThreeFrames(videoId: string): Promise<FrameResult[]> {
  const urls = getCandidateFrameUrls(videoId)
  const results: FrameResult[] = []
  const seenSigs = new Set<string>()

  for (const url of urls) {
    if (results.length >= 3) break
    const f = await fetchFrameAsBase64(url)
    if (!f) continue
    const sig = f.base64.slice(0, 80)
    if (seenSigs.has(sig)) continue
    seenSigs.add(sig)
    results.push(f)
  }

  console.log(`[frames] collected ${results.length}/3 frames`)
  return results
}

// ─── STEP 2 — VISION API FRAME SCORING ───────────────────────────────────────
// Uses TEXT_DETECTION + SAFE_SEARCH_DETECTION to score each frame.
// Best frame = fewest visible text overlays, not blurry, visually informative.

interface VisionTextAnnotation {
  description: string
  boundingPoly?: unknown
}

interface VisionSafeSearchAnnotation {
  adult?: string
  violence?: string
}

interface VisionResponse {
  textAnnotations?: VisionTextAnnotation[]
  safeSearchAnnotation?: VisionSafeSearchAnnotation
  error?: { message: string }
}

/**
 * analyzeFramesWithVision
 * Calls Google Vision API for each frame and returns a score.
 * Score logic:
 *   base = 1.0
 *   - subtract 0.08 per text annotation beyond 3 (punishes subtitle-heavy frames)
 *   - subtract 0.3 if first annotation text is very long (full subtitle line)
 *   - clamp to [0.05, 1.0]
 * Frame with highest score is selected for reverse search.
 */
export async function analyzeFramesWithVision(
  frames: FrameResult[],
  visionKey: string
): Promise<VisionFrameScore[]> {
  const requests = frames.map((f) => ({
    image: { content: f.base64 },
    features: [
      { type: 'TEXT_DETECTION', maxResults: 10 },
    ],
  }))

  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
        signal: AbortSignal.timeout(20_000),
      }
    )

    if (!res.ok) {
      const err = await res.text()
      console.error('[vision] API error:', err.slice(0, 300))
      // Fall back to equal scores if Vision fails
      return frames.map((f) => ({
        frame: f, textAnnotationsCount: 0, score: 1.0,
        reason: 'Vision API unavailable — unscored',
      }))
    }

    const data = await res.json() as { responses: VisionResponse[] }

    return data.responses.map((r, i) => {
      const annotations = r.textAnnotations || []
      const count = annotations.length

      let score = 1.0
      // Each text annotation beyond 3 costs 0.08
      if (count > 3) score -= (count - 3) * 0.08
      // First annotation is the full-text merge — long = heavy subtitles
      if (count > 0 && annotations[0].description.length > 30) score -= 0.3
      // If Vision returned an error for this image
      if (r.error) score = 0.1

      score = Math.max(0.05, Math.min(1.0, score))

      let reason = `${count} text annotations detected`
      if (count === 0) reason = 'No text overlay — clean frame'
      else if (count <= 3) reason = `${count} annotations — minimal text`
      else reason = `${count} annotations — heavy overlay (penalised)`

      console.log(`[vision] frame ${i + 1}: count=${count} score=${score.toFixed(2)} → ${reason}`)

      return { frame: frames[i], textAnnotationsCount: count, score, reason }
    })
  } catch (e) {
    console.error('[vision] request failed:', (e as Error).message)
    return frames.map((f) => ({
      frame: f, textAnnotationsCount: 0, score: 1.0,
      reason: 'Vision request failed — unscored',
    }))
  }
}

// ─── STEP 3 — SERPAPI SEARCH ──────────────────────────────────────────────────

/**
 * searchWithSerpApi
 * Sends the best frame URL to Google Lens via SerpApi.
 * Returns unified matches.
 */
export async function searchWithSerpApi(
  frameUrl: string,
  apiKey: string
): Promise<UnifiedMatch[]> {
  try {
    const params = new URLSearchParams({
      engine: 'google_lens',
      url: frameUrl,
      api_key: apiKey,
    })
    const res = await fetch(`https://serpapi.com/search?${params}`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.error('[serpapi] HTTP', res.status)
      return []
    }
    const data = await res.json() as {
      visual_matches?: Array<Record<string, string>>
      exact_matches?: Array<Record<string, string>>
    }

    const unified: UnifiedMatch[] = []

    // Exact matches get higher base score
    for (const item of data.exact_matches || []) {
      const url = item['link'] || item['url'] || ''
      if (!url) continue
      const domain = extractDomain(url)
      unified.push({
        title: item['title'] || '',
        url,
        domain,
        matchType: 'exact_match',
        sourceScore: 0,
        thumbnail: item['thumbnail'] || '',
        rawRank: unified.length,
      })
    }

    for (const item of data.visual_matches || []) {
      const url = item['link'] || item['url'] || ''
      if (!url) continue
      const domain = extractDomain(url)
      unified.push({
        title: item['title'] || '',
        url,
        domain,
        matchType: 'visual_match',
        sourceScore: 0,
        thumbnail: item['thumbnail'] || '',
        rawRank: unified.length,
      })
    }

    console.log(`[serpapi] ${unified.length} matches (exact:${data.exact_matches?.length ?? 0} visual:${data.visual_matches?.length ?? 0})`)
    return unified
  } catch (e) {
    console.error('[serpapi] error:', (e as Error).message)
    return []
  }
}

// ─── STEP 4 — APIFY SEARCH ───────────────────────────────────────────────────

function extractApifyMatches(rows: Array<Record<string, unknown>>): UnifiedMatch[] {
  const results: UnifiedMatch[] = []
  const arrayKeys = [
    'visual-match', 'visualMatches', 'visualMatch', 'matches',
    'results', 'items', 'data', 'pages', 'links',
  ]

  for (const row of rows) {
    let handled = false
    for (const key of arrayKeys) {
      const candidate = row[key]
      if (Array.isArray(candidate) && candidate.length > 0) {
        for (const m of candidate as Record<string, string>[]) {
          const url = m['link'] || m['url'] || m['pageUrl'] || m['href'] || ''
          if (!url) continue
          const domain = extractDomain(url)
          results.push({
            title: m['title'] || m['name'] || '',
            url, domain,
            matchType: 'visual_match',
            sourceScore: 0,
            thumbnail: m['thumbnail'] || m['image'] || '',
            rawRank: results.length,
          })
        }
        handled = true
        break
      }
    }
    if (!handled) {
      const url = (row['link'] || row['url'] || row['pageUrl'] || '') as string
      if (url) {
        const domain = extractDomain(url)
        results.push({
          title: (row['title'] as string) || '',
          url, domain,
          matchType: 'visual_match',
          sourceScore: 0,
          thumbnail: (row['thumbnail'] as string) || '',
          rawRank: results.length,
        })
      }
    }
  }

  return results
}

async function pollApifyRun(runId: string, token: string, timeoutMs = 240_000): Promise<UnifiedMatch[]> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await sleep(6000)
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`,
      { signal: AbortSignal.timeout(10_000) }
    ).catch(() => null)
    if (!statusRes?.ok) continue

    const statusData = await statusRes.json() as {
      data: { status: string; defaultDatasetId?: string; stats?: { itemCount?: number } }
    }
    const { status, defaultDatasetId, stats } = statusData.data
    const itemCount = stats?.itemCount ?? 0
    console.log(`[apify] poll: status=${status} items=${itemCount}`)

    if (itemCount > 0 && defaultDatasetId) {
      const rows = await fetchApifyDataset(defaultDatasetId, token)
      const matches = extractApifyMatches(rows)
      if (matches.length > 0) return matches
    }

    if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(status)) {
      const rows = await fetchApifyDataset(defaultDatasetId, token,
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&limit=50`)
      return extractApifyMatches(rows)
    }
  }
  return []
}

async function fetchApifyDataset(
  datasetId: string | undefined,
  token: string,
  overrideUrl?: string
): Promise<Array<Record<string, unknown>>> {
  const url = overrideUrl ||
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=50`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return []
    return (await res.json()) as Array<Record<string, unknown>>
  } catch { return [] }
}

/**
 * searchWithApify
 * Sends the best frame URL to Apify Google Lens actor.
 * Tries multiple actor schemas; normalises output to UnifiedMatch[].
 */
export async function searchWithApify(
  frameUrl: string,
  token: string
): Promise<UnifiedMatch[]> {
  // Try primary actor first (MaNVYRogwHemtywEz), then fallback (nwua9Gu5YrADL7ZDj)
  const actors = [
    { id: 'MaNVYRogwHemtywEz', body: { imageUrls: [frameUrl], searchTypes: ['visual-match'], maxResults: 20 } },
    { id: 'nwua9Gu5YrADL7ZDj', body: { imageUrl: frameUrl, maxResults: 20, outputType: 'all' } },
  ]

  for (const actor of actors) {
    console.log(`[apify] trying actor ${actor.id}`)
    const startRes = await fetch(
      `https://api.apify.com/v2/acts/${actor.id}/runs?token=${token}&memory=2048&timeout=180`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actor.body),
        signal: AbortSignal.timeout(30_000),
      }
    ).catch(() => null)

    if (!startRes?.ok) {
      console.error(`[apify] actor ${actor.id} start failed`)
      continue
    }
    const startData = await startRes.json() as { data: { id: string } }
    const runId = startData.data?.id
    if (!runId) continue

    console.log(`[apify] run started: ${runId}`)
    const matches = await pollApifyRun(runId, token)
    if (matches.length > 0) {
      console.log(`[apify] actor ${actor.id} returned ${matches.length} matches`)
      return matches
    }
  }
  return []
}

// ─── STEP 5 — RANK SOURCE CANDIDATES ─────────────────────────────────────────

/**
 * rankSourceCandidates
 * Assigns a sourceScore [0–1] to each match and sorts descending.
 *
 * Signals used:
 *   +0.40 if matchType === 'exact_match'
 *   +0.25 if matchType === 'visual_match'
 *   +0.30 if domain is a known video/content platform
 *   −0.20 if domain is a known aggregator/spam site
 *   −0.02 per position in raw rank (earlier = better)
 *   clamp to [0.01, 0.99]
 */
export function rankSourceCandidates(matches: UnifiedMatch[]): UnifiedMatch[] {
  const scored = matches.map((m) => {
    let score = 0
    score += m.matchType === 'exact_match' ? 0.4 : 0.25
    score += domainOriginScore(m.domain)
    score -= m.rawRank * 0.02  // earlier results are slightly better
    score = Math.max(0.01, Math.min(0.99, score))
    return { ...m, sourceScore: parseFloat(score.toFixed(2)) }
  })

  return scored.sort((a, b) => b.sourceScore - a.sourceScore)
}

// ─── ROUTE HANDLER ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { url: string; provider: 'serpapi' | 'apify' }
    const { url, provider } = body

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'invalid_url' }, { status: 400 })
    }
    if (!provider || !['serpapi', 'apify'].includes(provider)) {
      return NextResponse.json({ error: 'invalid_provider' }, { status: 400 })
    }

    const videoId = extractVideoId(url.trim())
    if (!videoId) {
      return NextResponse.json({ error: 'invalid_url' }, { status: 400 })
    }

    // Check API keys
    const serpKey = process.env.SERPAPI_KEY
    const apifyToken = process.env.APIFY_API_TOKEN
    const visionKey = process.env.GOOGLE_CLOUD_VISION_API_KEY

    if (provider === 'serpapi' && !serpKey) {
      return NextResponse.json({ error: 'provider_key_missing', provider: 'serpapi' }, { status: 500 })
    }
    if (provider === 'apify' && !apifyToken) {
      return NextResponse.json({ error: 'provider_key_missing', provider: 'apify' }, { status: 500 })
    }

    console.log(`[find-source] START videoId=${videoId} provider=${provider}`)

    // STEP 1: Extract 3 frames
    const frames = await collectThreeFrames(videoId)
    if (frames.length === 0) {
      return NextResponse.json({ error: 'no_good_frame_found' }, { status: 422 })
    }

    // STEP 2: Score frames with Vision
    let frameScores: VisionFrameScore[]
    if (visionKey && frames.length > 0) {
      frameScores = await analyzeFramesWithVision(frames, visionKey)
    } else {
      // No Vision key — assign neutral scores
      frameScores = frames.map((f) => ({
        frame: f, textAnnotationsCount: 0, score: 1.0,
        reason: 'Vision API key not configured — unscored',
      }))
    }

    // Pick best frame
    const sorted = [...frameScores].sort((a, b) => b.score - a.score)
    const best = sorted[0]
    const bestFrame = best.frame
    console.log(`[find-source] best frame: ${bestFrame.url} (score=${best.score})`)

    // STEP 3: Search with chosen provider
    let rawMatches: UnifiedMatch[] = []
    let method = provider

    if (provider === 'serpapi' && serpKey) {
      rawMatches = await searchWithSerpApi(bestFrame.url, serpKey)
    } else if (provider === 'apify' && apifyToken) {
      rawMatches = await searchWithApify(bestFrame.url, apifyToken)
    }

    if (rawMatches.length === 0) {
      return NextResponse.json({
        error: 'no_likely_source_found',
        videoId,
        frames: frameScores.map((fs) => ({
          url: fs.frame.url,
          score: fs.score,
          reason: fs.reason,
          textCount: fs.textAnnotationsCount,
        })),
        selectedFrame: { url: bestFrame.url, score: best.score, reason: best.reason },
      }, { status: 200 })
    }

    // STEP 4: Rank
    const rankedMatches = rankSourceCandidates(rawMatches)
    const topCandidate = rankedMatches[0] || null

    const result: ProviderResult = {
      provider,
      selectedFrame: bestFrame.url,
      frameScores: frameScores.map((fs) => ({
        frame: { ...fs.frame, base64: '', dataUrl: '' }, // strip base64 from response
        textAnnotationsCount: fs.textAnnotationsCount,
        score: fs.score,
        reason: fs.reason,
      })),
      matches: rankedMatches.slice(0, 15),
      topCandidate,
      method,
    }

    return NextResponse.json(result)

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[find-source]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
