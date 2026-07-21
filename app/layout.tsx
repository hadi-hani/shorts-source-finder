import './globals.css'

export const metadata = {
  title: 'Shorts Source Finder',
  description: 'Find the original source of a YouTube Short via reverse image search',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
