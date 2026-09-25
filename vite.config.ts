import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Worker serves the build output as its static assets, so `assets.directory`
// in wrangler.jsonc and `outDir` here name the same folder and have to move
// together. `client/public` holds the two files index.html links by absolute
// path, the manifest and the touch icon, which vite copies through unhashed.
export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  plugins: [react()],
});
