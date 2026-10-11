import { render } from 'react-dom'

import App from './App'
import { installDpopFetchInterceptor } from './delta/auth-fetch'
import { installDeltaWebMcp } from './pages-v2/delta/webmcp'

// DPoP proofs attach to every same-origin fetch once a bound session exists —
// must be installed before any API traffic starts.
installDpopFetchInterceptor()
// WebMCP tool surface for agent-capable browsers — read-only, inert on
// browsers without navigator.modelContext support.
installDeltaWebMcp()

render(<App />, document.getElementById('root'))
