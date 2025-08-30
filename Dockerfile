# Use the official Azure Functions Node.js base image
FROM mcr.microsoft.com/azure-functions/node:4-node18-appservice

# Install Chrome dependencies (minimal set for headless Chrome)
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgtk-3-0 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libgconf-2-4 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Add Google Chrome's signing key and repository
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list

# Install Google Chrome Stable
RUN apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/* \
    && rm /usr/share/keyrings/googlechrome-linux-keyring.gpg

# Set environment variables for Puppeteer-Core
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV CHROME_BIN=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

# Set the working directory
WORKDIR /home/site/wwwroot

# Copy package files first for Docker caching
COPY package*.json ./

# Install Node.js dependencies (production only)
RUN npm ci --only=production && npm cache clean --force

# Copy the rest of the application files
COPY . .

# Create a non-root user for security (Chrome requirement)
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /home/site/wwwroot

# Switch to non-root user
USER pptruser

# Verify Chrome installation
RUN google-chrome-stable --version

# Expose the default Azure Functions port
EXPOSE 80

# Health check to ensure Chrome is working
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD google-chrome-stable --version || exit 1

# Start the Azure Functions runtime
CMD ["/azure-functions-host/Microsoft.Azure.WebJobs.Script.WebHost"]