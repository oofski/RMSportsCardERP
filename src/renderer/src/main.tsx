import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/theme.css'
import './styles/app.css'
import App from './App'
import { SessionProvider } from './lib/session'
import { ToastProvider } from './components/Toast'
import { ThemeProvider } from './lib/theme'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
)
