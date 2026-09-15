import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // buildApp() now refuses to start without these. The values are only used
    // inside the suite and have no tie to any real environment.
    env: {
      JWT_SECRET: 'test-only-secret',
      INITIATOR_SERVICE_SECRET: 'test-only-initiator-secret',
    },
    include: ['tests/**/*.test.ts'],
    globals: true,
    restoreMocks: true,
    clearMocks: true,
    setupFiles: ['./tests/setup.ts'],
  },
})
