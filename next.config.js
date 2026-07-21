/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    APIFY_API_TOKEN: process.env.APIFY_API_TOKEN,
    SERPAPI_KEY: process.env.SERPAPI_KEY,
  }
}
module.exports = nextConfig
