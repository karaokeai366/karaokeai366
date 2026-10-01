import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'KaraokeAI',
        short_name: 'KaraokeAI',
        description: 'Karaokê distribuído, local-first e multiplataforma.',
        theme_color: '#0b1020',
        background_color: '#0b1020',
        display: 'standalone',
        orientation: 'portrait-primary',
        icons: []
      },
      workbox: {
        navigateFallback: '/index.html'
      }
    })
  ]
});
