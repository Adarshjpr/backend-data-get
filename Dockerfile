FROM node:20-alpine

WORKDIR /app

# Install dependencies first
COPY package*.json ./

RUN npm ci --omit=dev

# Copy application
COPY server.js ./

# Environment
ENV NODE_ENV=production

# App port
EXPOSE 3000

# Run application
CMD ["npm", "start"]