const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Get the current directory (Azure Functions context)
const getCurrentDir = () => {
  return process.cwd();
};

// Create logs directory if it doesn't exist
const createLogsDir = () => {
  const logsDir = path.join(getCurrentDir(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
};

// Function to extract domain from URL
const getDomain = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
};

// Function to normalize URLs for deduplication
const normalizeUrl = (url) => {
  try {
    const urlObj = new URL(url);
    // Remove fragment but keep the base URL
    urlObj.hash = '';
    // Keep query params as they might be significant for different pages
    return urlObj.href;
  } catch {
    return url;
  }
};

// Function to get all internal links from a page
const extractLinks = async (page, baseUrl, sameOriginOnly = true) => {
  try {
    const links = await page.evaluate((baseUrl, sameOriginOnly) => {
      const baseOrigin = new URL(baseUrl).origin;
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      
      console.log(`Found ${anchors.length} anchor tags on page`);
      
      const processedLinks = anchors
        .map(anchor => {
          const href = anchor.getAttribute('href');
          if (!href) return null;
          
          try {
            // Handle absolute URLs
            if (href.startsWith('http')) {
              return new URL(href).href;
            }
            // Handle relative URLs
            const absoluteUrl = new URL(href, baseUrl);
            return absoluteUrl.href;
          } catch {
            return null;
          }
        })
        .filter((href) => href !== null)
        .filter(href => {
          if (!sameOriginOnly) return true;
          try {
            return new URL(href).origin === baseOrigin;
          } catch {
            return false;
          }
        })
        .filter(href => {
          // Filter out common non-content URLs but KEEP fragment URLs
          const url = href.toLowerCase();
          return !url.includes('mailto:') && 
                 !url.includes('tel:') && 
                 !url.includes('javascript:') &&
                 !url.endsWith('.pdf') &&
                 !url.endsWith('.zip') &&
                 !url.endsWith('.exe') &&
                 !url.endsWith('.doc') &&
                 !url.endsWith('.docx');
        });
      
      console.log(`After filtering: ${processedLinks.length} valid links found`);
      return processedLinks;
    }, baseUrl, sameOriginOnly);

    const uniqueLinks = [...new Set(links.map(normalizeUrl))];
    console.log(`[${getDomain(baseUrl)}] Extracted ${uniqueLinks.length} unique links`);
    return uniqueLinks;
  } catch (error) {
    console.error('Error extracting links:', error);
    return [];
  }
};

// Function to check a single page for errors with fresh page instance
const checkPageForErrors = async (
  browser, 
  url, 
  depth, 
  baseUrl, 
  sameOriginOnly = true,
  retryCount = 0
) => {
  const logs = [];
  const startTime = Date.now();
  let page = null;
  const maxRetries = 2;

  try {
    // Check if browser is still connected
    if (!browser.isConnected()) {
      throw new Error('Browser connection lost');
    }

    // Create a fresh page for each URL to avoid state leakage
    page = await browser.newPage();

    // Set a reasonable timeout for page operations
    page.setDefaultTimeout(30000); // Increased timeout
    page.setDefaultNavigationTimeout(30000);

    // Set viewport for consistent rendering
    await page.setViewport({ width: 1280, height: 720 });

    // Set user agent to avoid bot detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Add extra headers to appear more like a real browser
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive'
    });

    // Set up error listeners with connection checks
    const errorHandler = (error) => {
      // Skip navigation errors as they're handled separately
      if (error.message.includes('detached') || error.message.includes('Navigation') || error.message.includes('Connection closed')) {
        return;
      }
      const logEntry = {
        type: 'pageerror',
        message: error.message,
        timestamp: new Date().toISOString(),
        pageUrl: url,
        stack: error.stack
      };
      logs.push(logEntry);
      console.log(`[${getDomain(url)}] Page Error:`, error.message);
    };

    const consoleHandler = (msg) => {
      try {
        if (page && !page.isClosed()) {
          const log = {
            type: msg.type(),
            message: msg.text(),
            timestamp: new Date().toISOString(),
            pageUrl: url
          };
          
          if (['error', 'warning', 'assert'].includes(msg.type())) {
            console.log(`[${getDomain(url)}] Console ${msg.type()}:`, msg.text());
          }
          
          logs.push(log);
        }
      } catch (e) {
        // Skip console handler errors
      }
    };

    const requestFailedHandler = (request) => {
      try {
        if (page && !page.isClosed()) {
          const logEntry = {
            type: 'network-error',
            message: `Failed to load: ${request.url()} - ${request.failure()?.errorText || 'Unknown error'}`,
            timestamp: new Date().toISOString(),
            pageUrl: url,
            url: request.url()
          };
          logs.push(logEntry);
          console.log(`[${getDomain(url)}] Network Error:`, request.url(), request.failure()?.errorText);
        }
      } catch (e) {
        // Skip handler errors
      }
    };

    const responseHandler = (response) => {
      try {
        if (page && !page.isClosed() && response.status() >= 400) {
          const logEntry = {
            type: 'http-error',
            message: `HTTP ${response.status()}: ${response.url()}`,
            timestamp: new Date().toISOString(),
            pageUrl: url,
            url: response.url()
          };
          logs.push(logEntry);
          console.log(`[${getDomain(url)}] HTTP Error:`, response.status(), response.url());
        }
      } catch (e) {
        // Skip handler errors
      }
    };

    // Add event listeners with connection checks
    if (page && !page.isClosed()) {
      page.on('pageerror', errorHandler);
      page.on('console', consoleHandler);
      page.on('requestfailed', requestFailedHandler);
      page.on('response', responseHandler);
    }

    console.log(`[Depth ${depth}] Crawling: ${url}`);

    // Navigate with better error handling and connection checks
    try {
      if (!browser.isConnected()) {
        throw new Error('Browser connection lost before navigation');
      }

      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 // Increased timeout
      });

      // Check if navigation was successful
      if (!response) {
        throw new Error('Navigation failed - no response received');
      }

      // Check connection after navigation
      if (!browser.isConnected() || page.isClosed()) {
        throw new Error('Connection lost during navigation');
      }

      // Check for redirect
      const finalUrl = page.url();
      if (finalUrl !== url && !finalUrl.startsWith(url)) {
        console.log(`[${getDomain(url)}] Redirected to: ${finalUrl}`);
      }

    } catch (navigationError) {
      // Handle specific navigation errors with retry logic
      if ((navigationError.message.includes('detached') || 
           navigationError.message.includes('Connection closed') ||
           navigationError.message.includes('Protocol error')) && 
          retryCount < maxRetries) {
        console.log(`[${getDomain(url)}] Retrying due to connection issue (attempt ${retryCount + 1})`);
        if (page && !page.isClosed()) {
          await page.close();
        }
        // Add a small delay before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
        return checkPageForErrors(browser, url, depth, baseUrl, sameOriginOnly, retryCount + 1);
      }
      throw navigationError;
    }

    // Minimal wait for initial render
    await new Promise(resolve => setTimeout(resolve, 1500)); // Slightly longer wait

    // Simplified error handler injection
    try {
      if (!page.isClosed()) {
        await page.evaluate(() => {
          window.onerror = (message, source, lineno, colno, error) => {
            console.error('JavaScript Error:', String(message));
            return false;
          };
          
          window.addEventListener('unhandledrejection', (event) => {
            console.error('Unhandled Promise Rejection:', event.reason);
          });
        });
      }
    } catch (e) {
      console.log(`[${getDomain(url)}] Could not inject error handlers`);
    }

    // Simplified scrolling
    try {
      if (!page.isClosed()) {
        await page.evaluate(() => {
          return new Promise((resolve) => {
            const maxScroll = Math.min(document.body.scrollHeight, 3000);
            const scrollStep = 500;
            let currentScroll = 0;
            
            const scrollInterval = setInterval(() => {
              currentScroll += scrollStep;
              window.scrollBy(0, scrollStep);
              
              if (currentScroll >= maxScroll) {
                clearInterval(scrollInterval);
                window.scrollTo(0, 0);
                setTimeout(resolve, 500);
              }
            }, 100);

            // Safety timeout
            setTimeout(() => {
              clearInterval(scrollInterval);
              resolve();
            }, 5000);
          });
        });
      }
    } catch (e) {
      console.log(`[${getDomain(url)}] Could not scroll page`);
    }

    // Check for broken images
    let additionalIssues = [];
    try {
      if (!page.isClosed()) {
        additionalIssues = await page.evaluate(() => {
          const issues = [];
          const images = Array.from(document.querySelectorAll('img'));
          
          images.slice(0, 50).forEach((img, index) => {
            if (img.complete && img.naturalHeight === 0 && img.src) {
              issues.push({
                type: 'broken-image',
                message: `Broken image: ${img.src.substring(0, 100)}`,
                element: `img[${index}]`
              });
            }
          });
          
          return issues;
        });
      }
    } catch (e) {
      console.log(`[${getDomain(url)}] Could not check images`);
    }

    // Add issues to logs
    additionalIssues.forEach(issue => {
      logs.push({
        type: issue.type,
        message: issue.message,
        timestamp: new Date().toISOString(),
        pageUrl: url
      });
    });

    // Extract links with connection check
    let extractedLinks = [];
    if (baseUrl && !page.isClosed()) {
      try {
        extractedLinks = await extractLinks(page, baseUrl, sameOriginOnly);
      } catch (e) {
        console.log(`[${getDomain(url)}] Could not extract links:`, e.message);
      }
    }

    const errorCount = logs.filter(log => 
      ['error', 'pageerror', 'network-error', 'http-error', 'javascript-error', 'unhandled-rejection', 'broken-image'].includes(log.type)
    ).length;

    const loadTime = Date.now() - startTime;

    return {
      url,
      status: 'success',
      errorCount,
      logs,
      loadTime,
      depth,
      extractedLinks
    };

  } catch (error) {
    console.error(`[${getDomain(url)}] Failed to load:`, error.message);

    // Handle specific error types
    let errorMessage = error.message;
    if (error.message.includes('detached') || error.message.includes('Connection closed')) {
      errorMessage = `Browser connection lost during navigation`;
    } else if (error.message.includes('Protocol error')) {
      errorMessage = `Browser protocol error - connection unstable`;
    } else if (error.message.includes('timeout') || error.message.includes('Navigation timeout')) {
      errorMessage = `Page load timeout (30s) - page may be slow or unresponsive`;
    } else if (error.message.includes('net::ERR_')) {
      errorMessage = `Network error: ${error.message}`;
    }

    const logEntry = {
      type: 'crawl-error',
      message: `Failed to crawl ${url}: ${errorMessage}`,
      timestamp: new Date().toISOString(),
      pageUrl: url,
      stack: error.stack
    };
    logs.push(logEntry);

    return {
      url,
      status: 'error',
      errorCount: 1,
      logs,
      error: errorMessage,
      depth,
      extractedLinks: []
    };
  } finally {
    // Always close the page to prevent memory leaks
    if (page) {
      try {
        if (!page.isClosed()) {
          page.removeAllListeners();
          await page.close();
        }
      } catch (e) {
        console.warn(`[${getDomain(url)}] Error closing page:`, e.message);
      }
    }
  }
};

// Function to write crawl results to file
const writeCrawlResultsToFile = (baseUrl, results) => {
  const logsDir = createLogsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const domain = getDomain(baseUrl).replace(/\./g, '_');
  
  const logFilename = `${domain}_crawl_${timestamp}.txt`;
  const errorFilename = `${domain}_errors_${timestamp}.txt`;
  
  const logFilepath = path.join(logsDir, logFilename);
  const errorFilepath = path.join(logsDir, errorFilename);
  
  // Write comprehensive log file
  let content = `WEBSITE CRAWL REPORT\n`;
  content += `${'='.repeat(80)}\n`;
  content += `Base URL: ${baseUrl}\n`;
  content += `Generated: ${new Date().toISOString()}\n`;
  content += `Pages Crawled: ${results.length}\n`;
  content += `${'='.repeat(80)}\n\n`;

  // Summary
  const totalErrors = results.reduce((sum, result) => sum + result.errorCount, 0);
  const successfulPages = results.filter(r => r.status === 'success').length;
  const failedPages = results.filter(r => r.status === 'error').length;
  const validLoadTimes = results.filter(r => r.loadTime !== undefined);
  const avgLoadTime = validLoadTimes.length > 0 
    ? validLoadTimes.reduce((sum, r) => sum + (r.loadTime || 0), 0) / validLoadTimes.length
    : 0;

  content += `EXECUTIVE SUMMARY\n`;
  content += `${'='.repeat(80)}\n`;
  content += `Total Pages Crawled: ${results.length}\n`;
  content += `Successful Pages: ${successfulPages}\n`;
  content += `Failed Pages: ${failedPages}\n`;
  content += `Total Errors Found: ${totalErrors}\n`;
  content += `Average Load Time: ${avgLoadTime.toFixed(0)}ms\n`;
  content += `Success Rate: ${((successfulPages / results.length) * 100).toFixed(1)}%\n\n`;

  // Error summary by type
  const allLogs = results.flatMap(result => result.logs);
  const errorsByType = allLogs.reduce((acc, log) => {
    acc[log.type] = (acc[log.type] || 0) + 1;
    return acc;
  }, {});

  content += `ERROR BREAKDOWN BY TYPE\n`;
  content += `${'='.repeat(80)}\n`;
  Object.entries(errorsByType)
    .sort(([,a], [,b]) => b - a)
    .forEach(([type, count]) => {
      content += `${type.toUpperCase()}: ${count}\n`;
    });
  content += `\n`;

  // Detailed results by page
  content += `DETAILED RESULTS BY PAGE\n`;
  content += `${'='.repeat(80)}\n\n`;

  results.forEach((result, index) => {
    content += `PAGE #${index + 1}: ${result.url}\n`;
    content += `${'─'.repeat(60)}\n`;
    content += `Status: ${result.status.toUpperCase()}\n`;
    content += `Depth: ${result.depth}\n`;
    content += `Errors Found: ${result.errorCount}\n`;
    if (result.loadTime) {
      content += `Load Time: ${result.loadTime}ms\n`;
    }
    if (result.error) {
      content += `Critical Error: ${result.error}\n`;
    }

    const pageErrors = result.logs.filter(log => 
      ['error', 'pageerror', 'network-error', 'http-error', 'javascript-error', 'unhandled-rejection', 'broken-image', 'crawl-error'].includes(log.type)
    );

    if (pageErrors.length > 0) {
      content += `\nERRORS ON THIS PAGE:\n`;
      pageErrors.forEach((error, errorIndex) => {
        content += `  ${errorIndex + 1}. [${error.type.toUpperCase()}] ${error.message}\n`;
        if (error.stack) {
          content += `     Stack: ${error.stack.split('\n')[0]}\n`;
        }
        if (error.url && error.url !== result.url) {
          content += `     Resource: ${error.url}\n`;
        }
      });
    } else {
      content += `\nNo errors found on this page\n`;
    }
    content += `\n${'─'.repeat(60)}\n\n`;
  });

  // Write main log file
  fs.writeFileSync(logFilepath, content);
  
  // Write separate errors-only file
  let errorContent = `WEBSITE ERRORS ONLY\n`;
  errorContent += `${'='.repeat(80)}\n`;
  errorContent += `Base URL: ${baseUrl}\n`;
  errorContent += `Generated: ${new Date().toISOString()}\n`;
  errorContent += `Total Errors: ${totalErrors}\n`;
  errorContent += `${'='.repeat(80)}\n\n`;

  results.forEach((result) => {
    const pageErrors = result.logs.filter(log => 
      ['error', 'pageerror', 'network-error', 'http-error', 'javascript-error', 'unhandled-rejection', 'broken-image', 'crawl-error'].includes(log.type)
    );

    if (pageErrors.length > 0) {
      errorContent += `${result.url} (${pageErrors.length} errors)\n`;
      errorContent += `${'─'.repeat(60)}\n`;
      pageErrors.forEach((error, index) => {
        errorContent += `${index + 1}. [${error.timestamp}] ${error.type.toUpperCase()}\n`;
        errorContent += `   Message: ${error.message}\n`;
        if (error.stack) {
          errorContent += `   Stack: ${error.stack.split('\n').slice(0, 3).join('\n   ')}\n`;
        }
        if (error.url && error.url !== result.url) {
          errorContent += `   Resource: ${error.url}\n`;
        }
        errorContent += `\n`;
      });
      errorContent += `${'─'.repeat(60)}\n\n`;
    }
  });

  if (totalErrors === 0) {
    errorContent += `NO ERRORS FOUND! Your website is error-free.\n`;
  }

  fs.writeFileSync(errorFilepath, errorContent);
  
  console.log(`Comprehensive report saved to: ${logFilepath}`);
  console.log(`Errors-only report saved to: ${errorFilepath}`);
  
  return { logFile: logFilename, errorFile: errorFilename };
};

// FIXED Enhanced parallel crawling function - Better queue management
const crawlWithQueue = async (
  browser, 
  startUrl, 
  maxPages, 
  crawlDepth, 
  crawlSameOriginOnly,
  maxConcurrency = 2 // Reduced concurrency for stability
) => {
  
  const results = [];
  const visitedUrls = new Set();
  const pendingUrls = [{ url: startUrl, depth: 0 }];
  
  console.log(`Starting enhanced crawl of: ${startUrl}`);
  console.log(`Settings: maxPages=${maxPages}, depth=${crawlDepth}, sameOrigin=${crawlSameOriginOnly}, concurrency=${maxConcurrency}`);

  // Process URLs level by level to ensure proper crawling
  while (pendingUrls.length > 0 && results.length < maxPages) {
    // Sort pending URLs by depth to process level by level
    pendingUrls.sort((a, b) => a.depth - b.depth);
    
    const currentBatch = [];
    const remainingSlots = maxPages - results.length;
    
    // Take up to maxConcurrency URLs for this batch, prioritizing lower depths
    for (let i = 0; i < Math.min(maxConcurrency, remainingSlots) && pendingUrls.length > 0; i++) {
      const urlItem = pendingUrls.shift();
      if (urlItem) {
        const normalizedUrl = normalizeUrl(urlItem.url);
        if (!visitedUrls.has(normalizedUrl)) {
          visitedUrls.add(normalizedUrl);
          currentBatch.push(urlItem);
        }
      }
    }

    if (currentBatch.length === 0) {
      console.log('No more unique URLs to process');
      break;
    }

    console.log(`Processing batch of ${currentBatch.length} URLs (${results.length}/${maxPages} completed)`);

    // Process batch with proper error handling
    const batchPromises = currentBatch.map(async ({ url, depth }) => {
      try {
        const result = await checkPageForErrors(browser, url, depth, startUrl, crawlSameOriginOnly);
        
        // After successful crawl, collect links for next depth level
        if (result.status === 'success' && 
            depth < crawlDepth - 1 && 
            result.extractedLinks && 
            result.extractedLinks.length > 0) {
          
          const newLinks = result.extractedLinks
            .filter(link => !visitedUrls.has(normalizeUrl(link)))
            .slice(0, 20) // Limit links per page to prevent explosion
            .map(link => ({ url: link, depth: depth + 1 }));
          
          // Add new links to pending queue
          pendingUrls.push(...newLinks);
          console.log(`[${getDomain(url)}] Added ${newLinks.length} new links for depth ${depth + 1}`);
        }
        
        // Clean result for return
        const { extractedLinks, ...cleanResult } = result;
        return cleanResult;
        
      } catch (error) {
        console.error(`Error processing ${url}:`, error.message);
        return {
          url,
          status: 'error',
          errorCount: 1,
          logs: [{
            type: 'crawl-error',
            message: `Batch processing error: ${error.message}`,
            timestamp: new Date().toISOString(),
            pageUrl: url
          }],
          depth,
          error: error.message
        };
      }
    });

    // Wait for all URLs in batch to complete
    try {
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Process results and add successful ones
      batchResults.forEach((promiseResult, index) => {
        if (promiseResult.status === 'fulfilled') {
          results.push(promiseResult.value);
        } else {
          console.error(`Batch promise failed for ${currentBatch[index]?.url}:`, promiseResult.reason);
          results.push({
            url: currentBatch[index]?.url || 'unknown',
            status: 'error',
            errorCount: 1,
            logs: [{
              type: 'crawl-error',
              message: `Promise rejection: ${promiseResult.reason?.message || 'Unknown error'}`,
              timestamp: new Date().toISOString(),
              pageUrl: currentBatch[index]?.url || 'unknown'
            }],
            depth: currentBatch[index]?.depth || 0
          });
        }
      });
      
      console.log(`Batch completed. Progress: ${results.length}/${maxPages} pages, ${pendingUrls.length} URLs pending`);
      
      // Small delay between batches to prevent overwhelming the server
      if (pendingUrls.length > 0 && results.length < maxPages) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
    } catch (error) {
      console.error('Batch processing error:', error.message);
      break; // Exit if batch processing fails
    }
  }

  console.log(`Crawl completed: processed ${results.length} pages total`);
  return results;
};

// Enhanced Markdown formatting function
// Enhanced Markdown formatting function
const generateMarkdownReport = (baseUrl, results) => {
  const allLogs = results.flatMap(r => r.logs || []);

  // Filter: only keep meaningful errors (skip empty 404 noise)
  const errorLogs = allLogs.filter(log =>
    ['error', 'pageerror', 'javascript-error', 'unhandled-rejection'].includes(log.type) &&
    log.message.trim() !== 'Failed to load resource: the server responded with a status of 404 ()'
  );

  const totalPages = results.length;
  const successfulPages = results.filter(r => r.status === 'success').length;
  const failedPages = results.filter(r => r.status === 'error').length;

  let markdown = `# Crawl Report\n\n`;
  markdown += `**Base URL:** ${baseUrl}\n\n`;

  if (errorLogs.length > 0) {
    markdown += `## Errors (${errorLogs.length})\n`;
    errorLogs.forEach((log, i) => {
      markdown += `### ${i + 1}. [${log.type.toUpperCase()}]\n`;
      // Use pageUrl (where the error occurred) or url (if it's a resource error) or the base URL as fallback
      const sourceUrl = log.pageUrl || log.url || baseUrl;
      markdown += `- **URL:** ${sourceUrl}\n`;
      markdown += `- **Message:** ${log.message}\n\n`;
    });
  } else {
    markdown += `## Errors\nNo errors found ✅\n`;
  }

  return markdown;
};



// Azure Function entry point
module.exports = async function (context, req) {
  context.log('Azure Function crawl request received');

  const { 
    url, 
    maxPages = 10, 
    crawlDepth = 2,
    crawlSameOriginOnly = true,
    maxConcurrency = 2 // Reduced default concurrency
  } = req.body || {};

  if (!url) {
    context.res = {
      status: 400,
      headers: { "Content-Type": "text/markdown" },
      body: `# ❌ Crawl Failed\n\n**Error:** URL is required\n\n## Usage\nPlease provide a valid URL in the request body:\n\`\`\`json\n{\n  "url": "https://example.com",\n  "maxPages": 10,\n  "crawlDepth": 2\n}\n\`\`\``
    };
    return;
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    context.res = {
      status: 400,
      headers: { "Content-Type": "text/markdown" },
      body: `# ❌ Crawl Failed\n\n**Error:** Invalid URL format\n\n**Provided URL:** \`${url}\`\n\n## Requirements\n- URL must include protocol (http:// or https://)\n- URL must be properly formatted\n\n**Example:** \`https://example.com\``
    };
    return;
  }

  let browser;
  let results = [];

  try {
    context.log('Launching browser...');
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-networking',
        '--disable-ipc-flooding-protection',
        '--memory-pressure-off',
        '--max-old-space-size=2048' // Increased memory limit
      ],
      timeout: 60000,
      protocolTimeout: 60000
    });

    context.log('Browser launched successfully');
    context.log(`Starting crawl with settings: maxPages=${maxPages}, depth=${crawlDepth}, concurrency=${maxConcurrency}`);

    // Run crawling with improved queue management
    results = await crawlWithQueue(browser, url, maxPages, crawlDepth, crawlSameOriginOnly, maxConcurrency);

    context.log(`Crawl completed: ${results.length} pages processed`);

    // Generate enhanced markdown report
    const markdownOutput = generateMarkdownReport(url, results);

    context.res = {
      status: 200,
      headers: { 
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-cache"
      },
      body: markdownOutput
    };

  } catch (error) {
    context.log.error('Crawl Error:', error.message);
    context.log.error('Stack trace:', error.stack);

    let errorMessage = error.message;
    let suggestions = '';

    // Provide specific error handling suggestions
    if (error.message.includes('timeout') || error.message.includes('Navigation timeout')) {
      suggestions = `\n\n## Possible Solutions\n- The website may be slow or unresponsive\n- Try reducing the number of pages to crawl\n- Check if the website is accessible from your browser\n`;
    } else if (error.message.includes('net::ERR_')) {
      suggestions = `\n\n## Possible Solutions\n- Check your internet connection\n- Verify the URL is correct and accessible\n- The website may be blocking automated requests\n`;
    } else if (error.message.includes('Browser')) {
      suggestions = `\n\n## Possible Solutions\n- Browser initialization failed\n- Try again in a few moments\n- Reduce concurrency settings if provided\n`;
    }

    context.res = {
      status: 500,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
      body: `# ❌ Crawl Failed\n\n**Error:** ${errorMessage}\n\n**URL:** ${url}\n**Timestamp:** ${new Date().toISOString()}\n\n**Partial Results:** ${results.length} pages were processed before the error occurred.${suggestions}\n\n---\n*If this error persists, please check the website accessibility and try again with different parameters.*`
    };
  } finally {
    if (browser) {
      try {
        context.log('Closing browser...');
        await browser.close();
        context.log('Browser closed successfully');
      } catch (e) {
        context.log.warn('Error closing browser:', e.message);
      }
    }
  }
};