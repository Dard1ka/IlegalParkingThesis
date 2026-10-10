# ══════════════════════════════════════════════════════════════
# Frontend Dockerfile — React + Vite, served via nginx
# Multi-stage untuk image akhir yang ringan (~40 MB vs ~400 MB)
# ══════════════════════════════════════════════════════════════

# ── Stage 1: Build ────────────────────────────────────────────
# Node 22 LTS (Node 20 sudah habis masa dukungannya); hanya dipakai saat build.
FROM node:22-alpine AS builder

WORKDIR /app

# Install deps dulu (cache layer). `npm ci` memasang persis isi
# package-lock.json dan langsung gagal kalau tidak sinkron dengan package.json.
COPY parking-dashboard/package*.json ./
RUN npm ci

# Copy source & build
COPY parking-dashboard/ ./

# Alamat backend di-bake ke bundle saat build (parking-dashboard/src/config.js).
# Kosong = otomatis http://<hostname halaman dashboard>:8000
ARG VITE_API_BASE=""
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build


# ── Stage 2: Runtime (nginx serve static) ─────────────────────
FROM nginx:alpine

# Copy hasil build ke nginx html dir
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx config (SPA routing + gzip + cache header)
COPY docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
