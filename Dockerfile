# Trickle web demo, hosted in demo mode: in-memory Fiber mock, no live nodes, settlement simulated.
# The real two-node run and the Stage B on-chain proof are in the video, the repo, and the live
# /api/proof read from Pudge. Runs unattended so judges can test after the hackathon.
FROM node:22-slim
WORKDIR /app

ENV TRICKLE_DEMO=1 \
    PORT=8099 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# pnpm via corepack, pinned to the version in package.json
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# the @trickle/* packages the demo imports resolve from dist/, so build them at image time
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r --filter "./packages/*" build

EXPOSE 8099
CMD ["pnpm", "-C", "examples/web-demo", "dev"]
