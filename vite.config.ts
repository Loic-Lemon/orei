import { defineConfig } from 'vitest/config';
export default defineConfig({build:{rolldownOptions:{onwarn(warning,defaultHandler){if(warning.code!=='MODULE_LEVEL_DIRECTIVE')defaultHandler(warning);}}},server:{port:1420,strictPort:true},test:{testTimeout:15000,environment:'jsdom',setupFiles:['./tests/setup.ts'],pool:'vmThreads',exclude:['**/node_modules/**','**/.worktrees/**']}});
