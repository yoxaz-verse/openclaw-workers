FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY worker.js ./worker.js

RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && chown -R appuser:appgroup /app

USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD node -e "const fs=require('fs');const p=process.env.HEARTBEAT_FILE||'/tmp/openclaw-worker-heartbeat';const max=Number(process.env.HEALTHCHECK_MAX_HEARTBEAT_AGE_MS||120000);try{const ts=Number(fs.readFileSync(p,'utf8'));if(!Number.isFinite(ts)||Date.now()-ts>max){process.exit(1)}process.exit(0)}catch(e){process.exit(1)}"

CMD ["npm", "start"]
