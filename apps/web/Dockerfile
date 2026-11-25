# Sayvox web pages (landing, sign-in, install, privacy, terms) on Cloud Run, replacing
# Firebase Hosting (owner decision 2026-11-26: Google Cloud instead of Firebase).
# Build from the repository root:
#   docker build -f apps/web/Dockerfile --build-arg VITE_FIREBASE_API_KEY=... -t sayvox-web .
# The API key is the public, API-restricted browser key for Identity Platform.
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@sayvox/web..."
COPY tsconfig.base.json ./
COPY apps/web apps/web
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN=sayvox-app-2026.firebaseapp.com
# "true" once Google sign-in is configured in Identity Platform.
ARG VITE_GOOGLE_SIGNIN=false
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN     VITE_GOOGLE_SIGNIN=$VITE_GOOGLE_SIGNIN
RUN test -n "$VITE_FIREBASE_API_KEY" || (echo "VITE_FIREBASE_API_KEY is required" && exit 1)
RUN pnpm --filter @sayvox/web exec vite build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
