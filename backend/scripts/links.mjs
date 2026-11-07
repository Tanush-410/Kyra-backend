// Prints ready-to-open links to the test consoles, with this machine's access tokens filled in.
// Usage: npm run links. The token goes after "#", so the browser never sends it to a server.
import { loadConfig, loadLocalEnv } from '../src/config.js';
import { ensureTokens } from '../src/lib/secrets.js';

loadLocalEnv();
const { config, file } = ensureTokens(loadConfig());
const base = `http://localhost:${config.port}/console`;
const withToken = (page, token) => `${base}/${page}${token ? `#token=${token}` : ''}`;

console.log(`
  Mirror console (visitor flow):  ${withToken('', config.apiToken)}
  Operations dashboard:           ${withToken('dashboard.html', config.operatorToken)}

  Tokens are kept in ${file}.
  The kiosk/frontend uses apiToken; operatorToken is for staff screens only.
  Start the backend first (npm start). If the links say "token needed", run this again after restarting.
`);
