FROM node:22-alpine

# 零运行时依赖，不需要 npm install
WORKDIR /app

ENV NODE_ENV=production \
    HIGHURL_PORT=8080 \
    HIGHURL_DATA_DIR=/data

COPY package.json ./
COPY src ./src
COPY public ./public
COPY assets ./assets

# 以非 root 用户运行，数据目录留给卷
RUN mkdir -p /data && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HIGHURL_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/cli.js", "serve"]
