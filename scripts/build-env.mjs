// scripts/build-env.mjs - writes public/env.js from environment variables (see .env.example).
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const e = process.env;
const firebase = e.FIREBASE_API_KEY && e.FIREBASE_PROJECT_ID
  ? {
      apiKey: e.FIREBASE_API_KEY,
      authDomain: e.FIREBASE_AUTH_DOMAIN || `${e.FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: e.FIREBASE_PROJECT_ID,
      appId: e.FIREBASE_APP_ID || undefined,
    }
  : null;
const env = { firebase, llmProxyUrl: e.LLM_PROXY_URL || '' };
writeFileSync('public/env.js', `window.GROKBOT_ENV = ${JSON.stringify(env, null, 2)};\n`);
console.log(`public/env.js written (firebase: ${firebase ? 'on' : 'off'}, llm proxy: ${env.llmProxyUrl ? 'on' : 'off'})`);
