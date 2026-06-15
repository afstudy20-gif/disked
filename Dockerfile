# Build frontend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Run backend
FROM node:20-alpine
WORKDIR /app
# Install docker-cli to allow containerized app to execute docker system prune against mounted host socket
RUN apk add --no-cache docker-cli
COPY package*.json ./
RUN npm install --production
COPY --from=builder /app/dist ./dist
COPY server.js ./

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5005

EXPOSE 5005
CMD ["node", "server.js"]
