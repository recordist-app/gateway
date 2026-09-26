# Container image for automated checks (Glama, Smithery). The gateway is a local stdio server:
# inside a container it has no Recordist app or database to talk to, so tools answer with a clear
# "Recordist app is not running" message, which is the expected result of a health check.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/cli.js"]
