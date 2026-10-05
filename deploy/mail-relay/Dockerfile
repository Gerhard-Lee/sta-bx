FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY index.mjs ./

USER node
EXPOSE 8080
CMD ["node", "index.mjs"]
