FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
COPY .buildstamp .buildstamp

CMD ["node","functions/server.mjs"]
