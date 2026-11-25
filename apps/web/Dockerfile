# Sayvox web pages (landing, sign-in, install, privacy, terms) on Cloud Run, replacing
# Firebase Hosting (owner decision 2026-11-26: Google Cloud instead of Firebase).
# Build once from the repository root and deploy the same image to every environment:
#   docker build -f apps/web/Dockerfile -t sayvox-web .
# Config comes from the service environment at start (nginx.conf.template -> /config.js):
#   FIREBASE_API_KEY (public, API-restricted Identity Platform key), FIREBASE_AUTH_DOMAIN,
#   GOOGLE_SIGNIN ("true" once Google sign-in is configured).
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@sayvox/web..."
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN pnpm --filter @sayvox/web exec vite build

FROM nginx:1.27-alpine
ENV FIREBASE_API_KEY="" FIREBASE_AUTH_DOMAIN="sayvox-app-2026.firebaseapp.com" GOOGLE_SIGNIN="false"
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
