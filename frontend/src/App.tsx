import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Sidebar } from './components/layout/Sidebar'
import { Dashboard } from './pages/Dashboard'
import { Settings } from './pages/Settings'
import { SystemHealth } from './pages/SystemHealth'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      retry: 2,
    },
  },
})

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <div className="font-sans font-bold text-[22px] text-fg-1">{title}</div>
        <div className="font-sans text-[13px] text-fg-3 mt-2">Coming soon.</div>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex h-screen bg-ink-deeper text-fg-1 font-sans overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-auto">
            <Routes>
              <Route path="/"         element={<Dashboard />} />
              <Route path="/health"   element={<SystemHealth />} />
              <Route path="/alerts"   element={<PlaceholderPage title="Alerts" />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
