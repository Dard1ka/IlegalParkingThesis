# ══════════════════════════════════════════════════════════════
# Frontend Dockerfile — React + Vite, served via nginx
# Multi-stage untuk image akhir yang ringan (~40 MB vs ~400 MB)
# ══════════════════════════════════════════════════════════════

# ── Stage 1: Build ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps dulu (cache layer)
COPY parking-dashboard/package*.json ./
RUN npm install

# Copy source & build
COPY parking-dashboard/ ./
RUN npm run build


# ── Stage 2: Runtime (nginx serve static) ─────────────────────
FROM nginx:alpine

# Copy hasil build ke nginx html dir
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx config (SPA routing + CORS headers)
COPY docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
