// installs window.velvet before anything uses it
import './bridge'
import '@fontsource-variable/inter'
import '@fontsource-variable/manrope'
import './styles/themes.css'
import './styles/global.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initMedia } from './lib/media'

const root = createRoot(document.getElementById('root')!)

// The mini player window loads the same page with #mini and must not start its own audio engine.
if (location.hash === '#mini') {
  void import('./mini/MiniApp').then(({ MiniApp }) =>
    root.render(
      <StrictMode>
        <MiniApp />
      </StrictMode>
    )
  )
} else {
  void Promise.all([import('./i18n'), import('./App'), initMedia()]).then(([, { App }]) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  )
}
