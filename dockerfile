FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm","start"]