# Production image for the web app. Build from the REPOSITORY ROOT:
#
#   docker build -f apps/web/Dockerfile --build-arg API_INTERNAL_URL=http://api:8000 .
#
# The root, because the app is an npm workspace that compiles its sibling packages.
# docker-compose.prod.yml does this for you.

FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN npm ci

# Where the Next.js server forwards /api/v1. Rewrites are compiled into the build, so
# this is a BUILD argument: an image built for one API address keeps calling it.
ARG API_INTERNAL_URL=http://api:8000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}

# Both runtime asset sets come from node_modules. Without the MapLibre worker every map
# renders a basemap and no potholes; without the ORT binaries the detector cannot start.
RUN npm run sync:ort-runtime --workspace @pothole/web \
 && npm run sync:maplibre-worker --workspace @pothole/web

# The model is not in Git. Fail here, loudly, rather than ship an image whose drive page
# silently falls back to the synthetic detector.
RUN test -f apps/web/public/models/model.json \
 || (echo "apps/web/public/models/model.json is missing - copy the exported model in first (docs/deploy.md)" && exit 1)

RUN npm run build --workspace @pothole/web

FROM node:22-bookworm-slim
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo /repo
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@pothole/web", "--", "-p", "3000", "-H", "0.0.0.0"]
