import { defineConfig } from 'vitest/config';

// Bounded LIVE checks against real services, using credentials from .dev.vars.live-test.
export default defineConfig({ test: { include: ['tests/live/**/*.live.ts'], testTimeout: 120000 } });
