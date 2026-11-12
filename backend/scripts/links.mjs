// Prints ready-to-open links to the kiosk UI and the test consoles, with this machine's access tokens filled in.
// Usage: npm run links. The token goes after "#", so the browser never sends it to a server.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, loadLocalEnv } from '../src/config.js';
import { ensureTokens } from '../src/lib/secrets.js';

loadLocalEnv();
const { config, file } = ensureTokens(loadConfig());
const origin = `http://localhost:${config.port}`;
const base = `${origin}/console`;
const withToken = (page, token) => `${base}/${page}${token ? `#token=${token}` : ''}`;
const uiPath = `/${config.frontendPath.replace(/^\/+|\/+$/g, '')}/`;
const uiBuilt = config.frontendDir && existsSync(path.join(config.frontendDir, 'index.html'));
const kiosk = !config.frontendDir
  ? '(off: FRONTEND_DIR is empty)'
  : uiBuilt
    ? `${origin}${uiPath}${config.apiToken ? `#token=${config.apiToken}` : ''}`
    : '(not built yet: cd ../Kyra-UI-V1 && npm ci && npm run build)';

console.log(`
  Kiosk UI (the team's mirror):   ${kiosk}
  Mirror console (visitor flow):  ${withToken('', config.apiToken)}
  Operations dashboard:           ${withToken('dashboard.html', config.operatorToken)}

  Tokens are kept in ${file}.
  The kiosk/frontend uses apiToken; operatorToken is for staff screens only.
  Start the backend first (npm start). If the links say "token needed", run this again after restarting.
`);
