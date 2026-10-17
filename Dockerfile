FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server ./server
COPY shared ./shared
COPY web ./web
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/server.js"]
