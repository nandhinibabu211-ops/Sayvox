# Sayvox API container for Cloud Run (T094). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t sayvox-api .
# The same image runs the API, migrations (`node --import tsx src/scripts/db.ts setup`) and
# the scheduled jobs (`node --import tsx src/scripts/job.ts reconcile|spend`).
FROM node:24-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/prompts/package.json packages/prompts/
RUN pnpm install --frozen-lockfile --filter "@sayvox/api..."

FROM node:24-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app ./
COPY tsconfig*.json ./
COPY packages/shared packages/shared
COPY packages/prompts packages/prompts
COPY apps/api apps/api
RUN rm -rf apps/api/test apps/api/.env*
USER node
EXPOSE 8080
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/server.ts"]
