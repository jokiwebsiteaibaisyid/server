# Gunakan Node versi stabil
FROM node:18

# Set directory
WORKDIR /app

# Copy package.json & package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy semua project
COPY . .

# Expose port
EXPOSE 2006

# Command start
CMD ["npm", "start"]
