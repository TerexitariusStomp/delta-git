import { render } from 'react-dom'

import App from './App'
import { installDpopFetchInterceptor } from './delta/auth-fetch'

// DPoP proofs attach to every same-origin fetch once a bound session exists —
// must be installed before any API traffic starts.
installDpopFetchInterceptor()

render(<App />, document.getElementById('root'))
