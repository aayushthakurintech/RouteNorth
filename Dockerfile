# One image holds the whole workspace; deploy/docker-compose.yml starts it as the API, the ingest service and the web app.
# Build from the repository root:  docker build -t routenorth .
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# The web app bakes these in at build time, so a different address needs a rebuild.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_COMPANY_NAME=
ARG NEXT_PUBLIC_PRIVACY_EMAIL=
ARG NEXT_PUBLIC_SUPPORT_EMAIL=
ARG NEXT_PUBLIC_GOVERNING_PROVINCE=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_COMPANY_NAME=$NEXT_PUBLIC_COMPANY_NAME \
    NEXT_PUBLIC_PRIVACY_EMAIL=$NEXT_PUBLIC_PRIVACY_EMAIL \
    NEXT_PUBLIC_SUPPORT_EMAIL=$NEXT_PUBLIC_SUPPORT_EMAIL \
    NEXT_PUBLIC_GOVERNING_PROVINCE=$NEXT_PUBLIC_GOVERNING_PROVINCE \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app /app
USER node
# The command is chosen per service in deploy/docker-compose.yml.
CMD ["node", "apps/api/dist/main.js"]
