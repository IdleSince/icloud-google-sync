import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { ApiError } from '@/api/client'
import { RequireAuth, UnauthorizedHandler } from '@/app/auth'
import { AppShell } from '@/components/layout/AppShell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useIsSplit } from '@/hooks/use-media-query'
import { DashboardPage } from '@/pages/DashboardPage'
import { GooglePage } from '@/pages/GooglePage'
import { ICloudPage } from '@/pages/ICloudPage'
import { LoginPage } from '@/pages/LoginPage'
import { LogsPage } from '@/pages/LogsPage'
import { SyncPage } from '@/pages/SyncPage'
import { ThemeProvider } from '@/theme/ThemeProvider'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      // Client errors (4xx) won't fix themselves by retrying.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
})

function Toasts() {
  const split = useIsSplit()
  return (
    <Toaster
      position={split ? 'bottom-right' : 'top-center'}
      mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
    />
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={400}>
          <BrowserRouter>
            <UnauthorizedHandler />
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                element={
                  <RequireAuth>
                    <AppShell />
                  </RequireAuth>
                }
              >
                <Route index element={<DashboardPage />} />
                <Route path="icloud" element={<ICloudPage />} />
                <Route path="google" element={<GooglePage />} />
                <Route path="sync" element={<SyncPage />} />
                <Route path="logs" element={<LogsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
          <Toasts />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
