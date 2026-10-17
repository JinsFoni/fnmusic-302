FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
ENV NODE_ENV=production
EXPOSE 8666
CMD ["node", "server.mjs"]
