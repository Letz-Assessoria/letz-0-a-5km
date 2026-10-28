// e2e do app no Hosting do emulador (porta 5050), com Auth, Firestore, Storage e
// Functions do projeto demo-letz e o Asaas falso (tests/fake-asaas.mjs, porta 7777).
// Rode com: npm run test:e2e  (o script copia core.js e cria os secrets falsos antes).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.mjs',
  use: {
    baseURL: 'http://localhost:5050',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/make-test-rules.mjs && firebase emulators:start --config firebase.test.json --project demo-letz',
    url: 'http://127.0.0.1:5050',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    // SIGINT deixa o firebase-tools derrubar os emuladores (o Java do Firestore
    // fica órfão com o SIGKILL padrão).
    gracefulShutdown: { signal: 'SIGINT', timeout: 30_000 },
  },
});
