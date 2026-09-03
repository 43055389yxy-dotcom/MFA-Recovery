FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS web

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/mfa-recovery').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]

FROM node:22-bookworm-slim AS api

ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && architecture="$(dpkg --print-architecture)" \
  && if [ "$architecture" = "arm64" ]; then aws_arch="aarch64"; else aws_arch="x86_64"; fi \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /var/lib/apt/lists/* /tmp/aws /tmp/awscliv2.zip
COPY scripts ./scripts
EXPOSE 3198
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3198/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "scripts/mfa-local-api.mjs"]
