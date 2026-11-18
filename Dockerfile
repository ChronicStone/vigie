# Two stages: the build tools never reach the running image.
ARG BUN_IMAGE=oven/bun:1.4.2-alpine
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json vite.config.ts ./
RUN bun install --frozen-lockfile
COPY sdk sdk
COPY server server
COPY web web
COPY definitions definitions
RUN bun run build
RUN find dist/client -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \) -exec gzip -k9 {} \;
RUN rm -rf node_modules && bun install --frozen-lockfile --production

FROM ${BUN_IMAGE}
WORKDIR /app
ENV NODE_ENV=production VIGIE_MODE=server VIGIE_DATA_DIR=/data VIGIE_HOST=0.0.0.0
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json tsconfig.json ./
COPY sdk sdk
COPY server server
COPY cli cli
COPY definitions definitions
RUN mkdir -p /data && chown -R bun:bun /data
USER bun
EXPOSE 4310 4318
VOLUME /data
HEALTHCHECK --interval=20s --timeout=4s --start-period=30s --retries=3 CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:4310/health'); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "server/index.ts"]
