# Build the site, then run it on plain Node: the server has no runtime dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
# package.json is needed for "type": "module".
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.mjs"]
