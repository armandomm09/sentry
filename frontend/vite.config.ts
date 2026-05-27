import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/hls': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      // Face-service WebSocket. The frontend uses /face/cameras/:id/ws and the
      // proxy strips the /face prefix when forwarding to the Python service.
      '/face': {
        target: 'http://localhost:8090',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/face/, ''),
      },
    },
  },
})
