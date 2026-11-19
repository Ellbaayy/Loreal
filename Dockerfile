FROM oven/bun:1.3.13
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY . .
# The app only reads files and talks to MySQL; it never needs root.
USER bun
EXPOSE 7860
CMD ["bun", "run", "src/index.ts"]
