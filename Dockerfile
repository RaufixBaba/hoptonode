FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    php-cli php-xml php-mbstring php-curl php-zip php-sqlite3 php-gd \
    openjdk-21-jre-headless python3 ca-certificates curl unzip tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
