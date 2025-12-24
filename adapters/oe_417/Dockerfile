FROM node:22-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

RUN pnpm install --prod
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["node","index.js"]
