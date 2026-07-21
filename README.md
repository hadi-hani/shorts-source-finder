# Shorts Source Finder

Find the original source of a YouTube Short via reverse image search (Google Lens).

## Features

- Paste any YouTube Shorts URL
- Extracts the video thumbnail automatically
- Searches Google Lens via **Apify** or **SerpApi**
- Returns ranked source matches with titles and links

## Setup

```bash
npm install
npm run dev
```

## Environment Variables

Create a `.env.local` file:

```env
APPIFY_API_TOKEN=your_apify_token
SERPAPI_KEY=your_serpapi_key
```

## Deploy

Deployed on [Vercel](https://vercel.com). Set the env vars in your Vercel project settings.
