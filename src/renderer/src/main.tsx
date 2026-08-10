import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/theme.css'
import './styles/app.css'
// LAST, and it has to be: every rule in it is an override of something app.css
// just said, and both live at the same specificity. Imported first it would
// lose every one of those and the phone layout would silently be the desktop
// one. Nothing in it can reach a desktop window — see the file's own header.
import './styles/mobile.css'
import App from './App'
import { SessionProvider } from './lib/session'
import { ToastProvider } from './components/Toast'
import { initSystemChrome } from './lib/systemChrome'
import { registerServiceWorkerEarly } from './lib/webPush'

// Before React, because it is a network fetch that nothing renders and the
// sooner the browser starts it the sooner an updated worker replaces the one on
// somebody's phone. A no-op in the desktop build, where there is no such thing
// as a service worker — see canRegisterServiceWorker.
registerServiceWorkerEarly()

// Also before React, and it has to be: it evicts a dark-mode preference left on
// machines that had the old toggle, and a screen that mounted first would paint
// once through an attribute nothing styles. See lib/systemChrome.ts.
initSystemChrome()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ToastProvider>
  </React.StrictMode>
)
