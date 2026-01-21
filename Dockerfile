FROM node:20-bullseye-slim

# Install Chromium + minimal deps needed for headless browsing
RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libnss3 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxrandr2 \
  libxshmfence1 \
  libxss1 \
  libxtst6 \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# We use system chromium; avoid downloading Chromium during npm install
# Puppeteer v20+ uses PUPPETEER_SKIP_DOWNLOAD; keep the legacy var too.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=3000

WORKDIR /app

COPY package.json package-lock.json* ./
# Install devDependencies for the build step (Tailwind/PostCSS live in devDeps)
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production

# Railway provides PORT; our npm start uses it.
EXPOSE 3000

CMD ["npm","run","start"]

