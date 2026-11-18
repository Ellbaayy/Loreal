FROM oven/bun:1.3.13
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY . .
EXPOSE 7860
CMD ["bun", "run", "src/index.ts"]
