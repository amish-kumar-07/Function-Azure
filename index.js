const { app } = require('@azure/functions');
const puppeteer = require('puppeteer');

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

// Enhanced function to get all internal links from a page
const extractLinks = async (page, baseUrl, sameOriginOnly = true) => {
  try {
    const links = await page.evaluate((baseUrl, sameOriginOnly) => {
      try {
        const baseOrigin = new URL(baseUrl).origin;
        const allLinks = new Set();
        
        // 1. Extract standard anchor tags with href
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        console.log(`Found ${anchors.length} anchor tags on page`);
        
        anchors.forEach(anchor => {
          const href = anchor.getAttribute('href');
          if (href) allLinks.add(href);
        });
        
        // 2. Extract links from navigation menus and common containers
        const navSelectors = [
          'nav a[href]',           // Navigation menus
          '.nav a[href]',          // Bootstrap-style nav
          '.navbar a[href]',       // Navbar links
          '.menu a[href]',         // Menu containers
          '.navigation a[href]',   // Navigation containers
          'header a[href]',        // Header links
          'footer a[href]',        // Footer links
          '.sidebar a[href]',      // Sidebar links
          '.breadcrumb a[href]',   // Breadcrumb navigation
          '.pagination a[href]',   // Pagination links
          'ul.nav a[href]',        // List-based navigation
          'ol.nav a[href]',        // Ordered list navigation
          '.main-nav a[href]',     // Main navigation
          '.sub-nav a[href]',      // Sub navigation
          '.site-nav a[href]',     // Site navigation
        ];
        
        navSelectors.forEach(selector => {
          try {
            const navLinks = Array.from(document.querySelectorAll(selector));
            navLinks.forEach(link => {
              const href = link.getAttribute('href');
              if (href) allLinks.add(href);
            });
          } catch (e) {
            console.log(`Error processing selector ${selector}:`, e.message);
          }
        });
        
        // 3. Extract clickable elements with data attributes that might contain URLs
        const dataSelectors = [
          '[data-href]',
          '[data-url]',
          '[data-link]',
          '[data-target]',
          '[data-route]'
        ];
        
        dataSelectors.forEach(selector => {
          try {
            const elements = Array.from(document.querySelectorAll(selector));
            elements.forEach(element => {
              const dataHref = element.getAttribute('data-href') || 
                              element.getAttribute('data-url') || 
                              element.getAttribute('data-link') ||
                              element.getAttribute('data-target') ||
                              element.getAttribute('data-route');
              if (dataHref) allLinks.add(dataHref);
            });
          } catch (e) {
            console.log(`Error processing data selector ${selector}:`, e.message);
          }
        });
        
        // 4. Extract form action URLs
        try {
          const forms = Array.from(document.querySelectorAll('form[action]'));
          forms.forEach(form => {
            const action = form.getAttribute('action');
            if (action && !action.startsWith('javascript:') && action !== '#') {
              allLinks.add(action);
            }
          });
        } catch (e) {
          console.log('Error processing forms:', e.message);
        }
        
        // 5. Extract area elements from image maps
        try {
          const areas = Array.from(document.querySelectorAll('area[href]'));
          areas.forEach(area => {
            const href = area.getAttribute('href');
            if (href) allLinks.add(href);
          });
        } catch (e) {
          console.log('Error processing image map areas:', e.message);
        }
        
        // 6. Extract base element href for relative URL resolution
        let documentBaseUrl = baseUrl;
        try {
          const baseElement = document.querySelector('base[href]');
          if (baseElement) {
            documentBaseUrl = baseElement.getAttribute('href') || baseUrl;
          }
        } catch (e) {
          console.log('Error processing base element:', e.message);
        }
        
        console.log(`Total unique raw links found: ${allLinks.size}`);
        
        // Process all collected links
        const processedLinks = Array.from(allLinks)
          .map(href => {
            if (!href || typeof href !== 'string') return null;
            
            // Clean up the href
            href = href.trim();
            if (!href) return null;
            
            try {
              // Handle absolute URLs
              if (href.startsWith('http://') || href.startsWith('https://')) {
                return new URL(href).href;
              }
              // Handle protocol-relative URLs
              if (href.startsWith('//')) {
                return new URL('https:' + href).href;
              }
              // Handle relative URLs (including those starting with /)
              const absoluteUrl = new URL(href, documentBaseUrl);
              return absoluteUrl.href;
            } catch (e) {
              console.log(`Failed to process URL: ${href}`, e.message);
              return null;
            }
          })
          .filter(href => href !== null)
          .filter(href => {
            if (!sameOriginOnly) return true;
            try {
              return new URL(href).origin === baseOrigin;
            } catch {
              return false;
            }
          })
          .filter(href => {
            // More comprehensive filtering
            const url = href.toLowerCase();
            
            // Skip non-content URLs
            if (url.includes('mailto:') || 
                url.includes('tel:') || 
                url.includes('javascript:') ||
                url.includes('void(0)') ||
                url === '#' ||
                url.endsWith('#')) {
              return false;
            }
            
            // Skip common file downloads (but allow some that might be pages)
            if (url.match(/\.(pdf|zip|exe|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4|avi|mov|jpg|jpeg|png|gif|svg|ico)$/)) {
              return false;
            }
            
            // Skip obvious non-page URLs
            if (url.includes('/download/') ||
                url.includes('/api/') ||
                url.includes('/ajax/') ||
                url.includes('/json/') ||
                url.includes('/xml/')) {
              return false;
            }
            
            return true;
          });
        
        console.log(`After processing and filtering: ${processedLinks.length} valid links`);
        return processedLinks;
      } catch (error) {
        console.error('Error in page.evaluate:', error.message);
        return [];
      }
    }, baseUrl, sameOriginOnly);

    const uniqueLinks = [...new Set(links.map(normalizeUrl))];
    console.log(`[${getDomain(baseUrl)}] Final extracted links: ${uniqueLinks.length} unique URLs`);
    
    // Log a sample of found links for debugging (first 5)
    if (uniqueLinks.length > 0) {
      console.log(`[${getDomain(baseUrl)}] Sample links:`, uniqueLinks.slice(0, 5));
    }
    
    return uniqueLinks;
  } catch (error) {
    console.error('Error extracting links:', error);
    return [];
  }
};

// MODIFIED: Enhanced function to check a single page for errors with comprehensive error handling
const checkPageForErrors = async (
  browser, 
  url, 
  depth, 
  baseOrigin,
  sameOriginOnly = true,
  retryCount = 0
) => {
  const logs = [];
  const startTime = Date.now();
  let page = null;
  const maxRetries = 2;

  try {
    // Check if browser is still connected
    if (!browser || !browser.isConnected()) {
      throw new Error('Browser connection lost or not available');
    }

    // Create a fresh page for each URL to avoid state leakage
    page = await browser.newPage();

    // Set a reasonable timeout for page operations
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

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

    // ENHANCED: Better page error handler that doesn't stop execution
    const errorHandler = (error) => {
      try {
        // Skip navigation errors as they're handled separately
        if (error.message && (
            error.message.includes('detached') || 
            error.message.includes('Navigation') || 
            error.message.includes('Connection closed')
        )) {
          return;
        }
        
        const logEntry = {
          type: 'pageerror',
          message: `${error.name || 'Error'}: ${error.message}`,
          timestamp: new Date().toISOString(),
          pageUrl: url,
          stack: error.stack || 'No stack trace available'
        };
        
        logs.push(logEntry);
        console.log(`[${getDomain(url)}] Page Error (continuing): ${error.name || 'Error'}: ${error.message}`);
      } catch (e) {
        // Fallback error logging
        logs.push({
          type: 'pageerror',
          message: 'Error processing page error: ' + (error?.message || 'Unknown error'),
          timestamp: new Date().toISOString(),
          pageUrl: url
        });
      }
    };

    // Enhanced console handler that resolves JSHandles to actual values
    const consoleHandler = async (msg) => {
      try {
        if (page && !page.isClosed()) {
          const msgType = msg.type();
          let messageText = '';
          
          try {
            // Get all arguments from the console message
            const args = msg.args();
            const resolvedArgs = [];
            
            for (const arg of args) {
              try {
                // Try to get the JSON value first (works for objects, arrays, primitives)
                const jsonValue = await arg.jsonValue();
                resolvedArgs.push(JSON.stringify(jsonValue, null, 2));
              } catch {
                try {
                  // If JSON fails, try to evaluate as string representation
                  const stringValue = await page.evaluate(obj => {
                    if (obj instanceof Error) {
                      return `${obj.name}: ${obj.message}\n${obj.stack}`;
                    }
                    if (typeof obj === 'object' && obj !== null) {
                      try {
                        return JSON.stringify(obj, null, 2);
                      } catch {
                        return obj.toString();
                      }
                    }
                    return String(obj);
                  }, arg);
                  resolvedArgs.push(stringValue);
                } catch {
                  // Final fallback - use the original text but try to clean it up
                  const argText = await arg.toString();
                  if (argText === 'JSHandle@error' || argText === 'JSHandle@object') {
                    // Try one more approach for error objects
                    try {
                      const errorDetails = await page.evaluate(obj => {
                        if (obj && obj.message) {
                          return `${obj.name || 'Error'}: ${obj.message}${obj.stack ? '\n' + obj.stack : ''}`;
                        }
                        return 'Unable to resolve error details';
                      }, arg);
                      resolvedArgs.push(errorDetails);
                    } catch {
                      resolvedArgs.push('Unresolvable object');
                    }
                  } else {
                    resolvedArgs.push(argText);
                  }
                }
              }
            }
            
            messageText = resolvedArgs.join(' ');
          } catch {
            // Final fallback to original text method
            messageText = msg.text();
          }
          
          const log = {
            type: msgType,
            message: messageText,
            timestamp: new Date().toISOString(),
            pageUrl: url
          };
          
          if (['error', 'warning', 'assert'].includes(msgType)) {
            console.log(`[${getDomain(url)}] Console ${msgType} (continuing):`, messageText);
          }
          
          logs.push(log);
        }
      } catch (e) {
        // Skip console handler errors but log a simple fallback
        console.log(`[${getDomain(url)}] Console message processing failed`);
      }
    };

    // Enhanced request failed handler
    const requestFailedHandler = (request) => {
      try {
        if (page && !page.isClosed()) {
          const failure = request.failure();
          const logEntry = {
            type: 'network-error',
            message: `Failed to load: ${request.url()} - ${failure?.errorText || 'Unknown network error'}`,
            timestamp: new Date().toISOString(),
            pageUrl: url,
            url: request.url(),
            errorText: failure?.errorText || 'Unknown error'
          };
          logs.push(logEntry);
          console.log(`[${getDomain(url)}] Network Error (continuing): ${request.url()} - ${failure?.errorText || 'Unknown error'}`);
        }
      } catch (e) {
        // Skip handler errors
      }
    };

    // Enhanced response handler for HTTP errors
    const responseHandler = (response) => {
      try {
        if (page && !page.isClosed() && response.status() >= 400) {
          const logEntry = {
            type: 'http-error',
            message: `HTTP ${response.status()}: ${response.url()}${response.statusText() ? ' - ' + response.statusText() : ''}`,
            timestamp: new Date().toISOString(),
            pageUrl: url,
            url: response.url(),
            status: response.status(),
            statusText: response.statusText()
          };
          logs.push(logEntry);
          console.log(`[${getDomain(url)}] HTTP Error (continuing): ${response.status()} ${response.statusText()} - ${response.url()}`);
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

    // MODIFIED: Continue processing even if navigation fails
    let navigationSuccessful = false;
    let navigationError = null;
    
    try {
      if (!browser.isConnected()) {
        throw new Error('Browser connection lost before navigation');
      }

      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 120000
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

      navigationSuccessful = true;

    } catch (navError) {
      navigationError = navError;
      console.log(`[${getDomain(url)}] Navigation failed but continuing: ${navError.message}`);
      
      // Log navigation error but continue processing
      logs.push({
        type: 'navigation-error',
        message: `Navigation failed: ${navError.message}`,
        timestamp: new Date().toISOString(),
        pageUrl: url,
        stack: navError.stack
      });

      // Handle specific navigation errors with retry logic
      if ((navError.message.includes('detached') || 
           navError.message.includes('Connection closed') ||
           navError.message.includes('Protocol error')) && 
          retryCount < maxRetries) {
        console.log(`[${getDomain(url)}] Retrying due to connection issue (attempt ${retryCount + 1})`);
        if (page && !page.isClosed()) {
          await page.close();
        }
        // Add a small delay before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
        return checkPageForErrors(browser, url, depth, baseOrigin, sameOriginOnly, retryCount + 1);
      }
    }

    // MODIFIED: Always try to extract links, even from failed pages
    let extractedLinks = [];
    
    if (navigationSuccessful && !page.isClosed()) {
      try {
        // Minimal wait for initial render
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Simplified error handler injection
        try {
          await page.evaluate(() => {
            window.onerror = (message, source, lineno, colno, error) => {
              console.error('JavaScript Error (handled):', String(message));
              return false; // Don't prevent default handling
            };
            
            window.addEventListener('unhandledrejection', (event) => {
              console.error('Unhandled Promise Rejection (handled):', event.reason);
            });
          });
        } catch (e) {
          console.log(`[${getDomain(url)}] Could not inject error handlers (continuing)`);
        }

        // Simplified scrolling
        try {
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
        } catch (e) {
          console.log(`[${getDomain(url)}] Could not scroll page (continuing)`);
        }

        // Check for broken images
        try {
          const additionalIssues = await page.evaluate(() => {
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

          // Add issues to logs
          additionalIssues.forEach(issue => {
            logs.push({
              type: issue.type,
              message: issue.message,
              timestamp: new Date().toISOString(),
              pageUrl: url,
              element: issue.element
            });
          });
        } catch (e) {
          console.log(`[${getDomain(url)}] Could not check images (continuing)`);
        }

        // Extract links using baseOrigin
        if (baseOrigin) {
          try {
            extractedLinks = await extractLinks(page, url, sameOriginOnly);
          } catch (e) {
            console.log(`[${getDomain(url)}] Could not extract links (continuing):`, e.message);
            // Log link extraction error but continue
            logs.push({
              type: 'link-extraction-error',
              message: `Failed to extract links: ${e.message}`,
              timestamp: new Date().toISOString(),
              pageUrl: url
            });
          }
        }
      } catch (processingError) {
        console.log(`[${getDomain(url)}] Error during page processing (continuing):`, processingError.message);
        logs.push({
          type: 'processing-error',
          message: `Page processing failed: ${processingError.message}`,
          timestamp: new Date().toISOString(),
          pageUrl: url,
          stack: processingError.stack
        });
      }
    }

    const errorCount = logs.filter(log => 
      ['error', 'pageerror', 'network-error', 'http-error', 'javascript-error', 'unhandled-rejection', 'broken-image', 'navigation-error', 'processing-error', 'link-extraction-error'].includes(log.type)
    ).length;

    const loadTime = Date.now() - startTime;

    // MODIFIED: Always return success/partial-success to keep crawling
    const status = navigationSuccessful ? 'success' : 'partial-success';

    return {
      url,
      status,
      errorCount,
      logs,
      loadTime,
      depth,
      extractedLinks,
      navigationSuccessful
    };

  } catch (criticalError) {
    console.error(`[${getDomain(url)}] Critical error during crawl (continuing):`, criticalError.message);

    // Handle specific error types
    let errorMessage = criticalError.message;
    if (criticalError.message.includes('detached') || criticalError.message.includes('Connection closed')) {
      errorMessage = `Browser connection lost during navigation`;
    } else if (criticalError.message.includes('Protocol error')) {
      errorMessage = `Browser protocol error - connection unstable`;
    } else if (criticalError.message.includes('timeout') || criticalError.message.includes('Navigation timeout')) {
      errorMessage = `Page load timeout (60s) - page may be slow or unresponsive`;
    } else if (criticalError.message.includes('net::ERR_')) {
      errorMessage = `Network error: ${criticalError.message}`;
    }

    const logEntry = {
      type: 'crawl-error',
      message: `Failed to crawl ${url}: ${errorMessage}`,
      timestamp: new Date().toISOString(),
      pageUrl: url,
      stack: criticalError.stack
    };
    logs.push(logEntry);

    // MODIFIED: Return partial success even for critical errors to keep crawling
    return {
      url,
      status: 'partial-success',
      errorCount: 1,
      logs,
      error: errorMessage,
      depth,
      extractedLinks: [],
      navigationSuccessful: false
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

// MODIFIED: Enhanced crawling function with better homepage failure handling
const crawlWithQueue = async (
  browser, 
  startUrl, 
  maxPages, 
  crawlDepth, 
  crawlSameOriginOnly,
  maxConcurrency = 2
) => {
  
  const results = [];
  const visitedUrls = new Set();
  const pendingUrls = [{ url: startUrl, depth: 0 }];

  console.log(`Starting enhanced crawl of: ${startUrl}`);
  console.log(`Settings: maxPages=${maxPages}, depth=${crawlDepth}, sameOrigin=${crawlSameOriginOnly}, concurrency=${maxConcurrency}`);

  while (pendingUrls.length > 0 && results.length < maxPages) {
    // Sort pending URLs by depth to process level by level
    pendingUrls.sort((a, b) => a.depth - b.depth);
    
    const currentBatch = [];
    const remainingSlots = maxPages - results.length;
    
    // Take up to maxConcurrency URLs for this batch
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

    // Process batch - never stop crawling due to individual page failures
    const batchPromises = currentBatch.map(async ({ url, depth }) => {
      try {
        // Check if this is the homepage
        const isHomepage = normalizeUrl(url) === normalizeUrl(startUrl);
        
        // Always attempt to crawl each page
        const result = await checkPageForErrors(browser, url, depth, startUrl, crawlSameOriginOnly);
        
        
        // Collect links even from pages with errors
        if (depth < crawlDepth - 1 && 
            result.extractedLinks && 
            result.extractedLinks.length > 0) {
          
          // Filter out already visited URLs and limit to prevent explosion
          const newLinks = result.extractedLinks
            .filter(link => !visitedUrls.has(normalizeUrl(link)))
            .slice(0, 100) // Limit to prevent explosion
            .map(link => ({ url: link, depth: depth + 1 }));
          
          // Add new links to pending queue
          pendingUrls.push(...newLinks);
          console.log(`[${getDomain(url)}] Added ${newLinks.length} new links for depth ${depth + 1}`);
          
          // Log some sample links being added for debugging
          if (newLinks.length > 0) {
            console.log(`[${getDomain(url)}] Sample new links:`, newLinks.slice(0, 3).map(item => item.url));
          }
        }
        
        // Clean result for return (remove extractedLinks to save memory)
        const { extractedLinks, ...cleanResult } = result;
        return cleanResult;
        
      } catch (batchError) {
        // Never let batch errors stop the crawling process
        console.error(`Batch processing error for ${url} (continuing):`, batchError.message);
        
        // Check if this was the homepage that failed
        const isHomepage = normalizeUrl(url) === normalizeUrl(startUrl);
        if (isHomepage) {
          console.log(`[${getDomain(url)}] Homepage batch processing failed, will use fallback strategies`);
        }
        
        // Return a detailed error result instead of throwing
        return {
          url,
          status: 'partial-success',
          errorCount: 1,
          logs: [{
            type: 'batch-error',
            message: `Batch processing failed: ${batchError.message}`,
            timestamp: new Date().toISOString(),
            pageUrl: url,
            stack: batchError.stack
          }],
          depth,
          error: batchError.message,
          navigationSuccessful: false
        };
      }
    });

    // Process all batch results, including failures
    try {
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Process all results - both fulfilled and rejected
      batchResults.forEach((promiseResult, index) => {
        if (promiseResult.status === 'fulfilled') {
          results.push(promiseResult.value);
        } else {
          // Log promise rejections but continue crawling
          console.error(`Promise failed for ${currentBatch[index]?.url} (continuing):`, promiseResult.reason?.message);
          
          // Check if this was the homepage that failed
          const isHomepage = normalizeUrl(currentBatch[index]?.url) === normalizeUrl(startUrl);
          if (isHomepage) {
            console.log(`[${getDomain(currentBatch[index]?.url)}] Homepage promise failed, will use fallback strategies`);
          }
          
          results.push({
            url: currentBatch[index]?.url || 'unknown',
            status: 'partial-success',
            errorCount: 1,
            logs: [{
              type: 'promise-rejection',
              message: `Promise rejected: ${promiseResult.reason?.message || 'Unknown promise error'}`,
              timestamp: new Date().toISOString(),
              pageUrl: currentBatch[index]?.url || 'unknown',
              stack: promiseResult.reason?.stack
            }],
            depth: currentBatch[index]?.depth || 0,
            navigationSuccessful: false
          });
        }
      });
      
      
      console.log(`Batch completed. Progress: ${results.length}/${maxPages} pages, ${pendingUrls.length} URLs pending`);
      
      // Small delay between batches to prevent overwhelming the server
      if (pendingUrls.length > 0 && results.length < maxPages) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
    } catch (batchProcessingError) {
      // Even if batch processing fails completely, log and continue
      console.error('Critical batch processing error (continuing):', batchProcessingError.message);
      
      // Add error results for all URLs in the failed batch
      currentBatch.forEach(({ url, depth }) => {
        results.push({
          url,
          status: 'partial-success',
          errorCount: 1,
          logs: [{
            type: 'batch-processing-error',
            message: `Critical batch processing failure: ${batchProcessingError.message}`,
            timestamp: new Date().toISOString(),
            pageUrl: url,
            stack: batchProcessingError.stack
          }],
          depth,
          navigationSuccessful: false
        });
      });
      
      // Continue to next batch despite the error
      console.log('Continuing crawl despite batch processing error...');
    }
  }

  console.log(`Crawl completed: processed ${results.length} pages total`);
  return results;
};

// Enhanced Markdown formatting function with better error categorization
const generateMarkdownReport = (baseUrl, results) => {
  const allLogs = results.flatMap(r => r.logs || []);

  // Enhanced error filtering and categorization
  const errorLogs = allLogs.filter(log =>
    ['error', 'pageerror', 'javascript-error', 'unhandled-rejection'].includes(log.type) &&
    typeof log.message === 'string' &&
    log.message.trim() !== '' &&
    log.message.trim() !== '{}' &&
    !log.message.includes('Failed to load resource: the server responded with a status of 404 ()')
  );

  const partialSuccessPages = results.filter(r => r.status === 'partial-success').length;

  // Enhanced statistics
  let markdown = `# Crawl Report\n\n`;
  markdown += `**Base URL:** ${baseUrl}\n`;
  if (partialSuccessPages > 0) {
    markdown += `**Partially Successful:** ${partialSuccessPages} (loaded with errors or fallback strategies used)\n`;
  }

  if (errorLogs.length > 0) {
    // Group errors by type for better organization
    const errorsByType = {};
    errorLogs.forEach(log => {
      const type = log.type;
      if (!errorsByType[type]) {
        errorsByType[type] = [];
      }
      errorsByType[type].push(log);
    });

    markdown += `## Errors by Category (${errorLogs.length} total)\n\n`;

    // Sort error types by severity and frequency
    const errorTypePriority = {
      'navigation-error': 1,
      'crawl-error': 2,
      'batch-error': 3,
      'batch-processing-error': 4,
      'promise-rejection': 5,
      'pageerror': 6,
      'javascript-error': 7,
      'unhandled-rejection': 8,
      'network-error': 9,
      'http-error': 10,
      'processing-error': 11,
      'link-extraction-error': 12,
      'broken-image': 13,
      'error': 14,
      'warning': 15
    };

    const sortedErrorTypes = Object.keys(errorsByType).sort((a, b) => {
      const priorityA = errorTypePriority[a] || 99;
      const priorityB = errorTypePriority[b] || 99;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return errorsByType[b].length - errorsByType[a].length;
    });

    sortedErrorTypes.forEach(errorType => {
      const errors = errorsByType[errorType];
      const typeTitle = errorType.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      markdown += `### ${typeTitle} (${errors.length})\n`;
      
      errors.forEach((log, i) => {
        const sourceUrl = log.pageUrl || log.url || 'Unknown URL';
        markdown += `**${i + 1}.** ${sourceUrl}\n`;
        
        let fullMessage = log.message;

        if (log.stack) {
          const stackLines = log.stack.split('\n').slice(0, 3).join('\n');
          fullMessage += `\n  *Stack Trace:*\n  \`\`\`\n  ${stackLines}\n  \`\`\``;
        }

        if (log.element) {
          fullMessage += `\n  *Element:* ${log.element}`;
        }

        if (log.status) {
          fullMessage += `\n  *HTTP Status:* ${log.status}`;
        }

        if (log.errorText) {
          fullMessage += `\n  *Error Details:* ${log.errorText}`;
        }

        markdown += `- ${fullMessage}\n\n`;
      });
    });
  } else {
    markdown += `## Errors\nNo errors found\n\n`;
  }

  // Enhanced page summary with status indicators
  markdown += `## Crawled Pages Summary\n`;
  results.forEach((result, i) => {
    let status = '';
    if (result.status === 'success') {
      status = 'SUCCESS';
    } else if (result.status === 'partial-success') {
      status = 'PARTIAL';
    } else {
      status = 'FAILED';
    }
    
    const errorCount = result.errorCount || 0;
    const loadTime = result.loadTime ? ` (${result.loadTime}ms)` : '';
    const depth = result.depth !== undefined ? ` [depth: ${result.depth}]` : '';
    
    markdown += `${i + 1}. [${status}] ${result.url} - ${errorCount} errors${loadTime}${depth}\n`;
  });

  return markdown;
};

// Enhanced Azure Functions HTTP trigger with Docker-compatible Puppeteer configuration
app.http('crawl', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    context.log('Azure Function v4 crawl request received');

    let requestBody;
    try {
      requestBody = await request.json();
    } catch (error) {
      return {
        status: 400,
        headers: { "Content-Type": "text/markdown" },
        body: `# Crawl Failed\n\n**Error:** Invalid JSON in request body\n\n## Usage\nPlease provide a valid JSON body:\n\`\`\`json\n{\n  "url": "https://example.com",\n  "maxPages": 50,\n  "crawlDepth": 4\n}\n\`\``
      };
    }

    const { 
      url, 
      maxPages = 50,
      crawlDepth = 4,
      crawlSameOriginOnly = true,
      maxConcurrency = 2
    } = requestBody;

    if (!url) {
      return {
        status: 400,
        headers: { "Content-Type": "text/markdown" },
        body: `# Crawl Failed\n\n**Error:** URL is required\n\n## Usage\nPlease provide a valid URL in the request body:\n\`\`\`json\n{\n  "url": "https://example.com",\n  "maxPages": 50,\n  "crawlDepth": 4\n}\n\`\``
      };
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return {
        status: 400,
        headers: { "Content-Type": "text/markdown" },
        body: `# Crawl Failed\n\n**Error:** Invalid URL format\n\n**Provided URL:** \`${url}\`\n\n## Requirements\n- URL must include protocol (http:// or https://)\n- URL must be properly formatted\n\n**Example:** \`https://example.com\``
      };
    }

    let browser;
    let results = [];

    try {
      context.log('Launching browser...');
      
      // Enhanced browser configuration for Docker environment
      const browserArgs = [
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
        '--max-old-space-size=2048',
        // Additional Docker-specific args
        '--disable-extensions',
        '--disable-plugins',
        '--disable-sync',
        '--disable-translate',
        '--disable-background-downloads',
        '--disable-component-extensions-with-background-pages',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-domain-reliability',
        '--disable-component-update',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-field-trial-config',
        '--disable-back-forward-cache',
        '--disable-ipc-flooding-protection',
        '--run-all-compositor-stages-before-draw',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees,VizDisplayCompositor,AudioServiceOutOfProcess',
        '--single-process' // Add this for better compatibility in containers
      ];

      // Detect if we're running in Docker/Container environment
      const isDocker = process.env.PUPPETEER_EXECUTABLE_PATH || 
                       process.env.CHROME_BIN || 
                       require('fs').existsSync('/.dockerenv');

      const launchConfig = {
        headless: true,
        args: browserArgs,
        timeout: 60000,
        protocolTimeout: 60000
      };

      // Use system Chrome if available (Docker environment)
      if (isDocker) {
        const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || 
                          process.env.CHROME_BIN || 
                          '/usr/bin/google-chrome-stable';
        
        context.log(`Using system Chrome at: ${chromePath}`);
        launchConfig.executablePath = chromePath;
      }

      browser = await puppeteer.launch(launchConfig);

      context.log('Browser launched successfully');
      console.log('Browser version:', await browser.version());
      context.log(`Starting resilient crawl with settings: maxPages=${maxPages}, depth=${crawlDepth}, concurrency=${maxConcurrency}`);
      
      // Run crawling with enhanced error resilience - never stop on homepage failures
      try {
        results = await crawlWithQueue(browser, url, maxPages, crawlDepth, crawlSameOriginOnly, maxConcurrency);
        context.log(`Crawl completed: ${results.length} pages processed with enhanced resilience`);
      } catch (crawlError) {
        // Even if crawlWithQueue throws an error, we continue with partial results
        context.error('Crawl error occurred, but continuing with partial results:', crawlError.message);
        
        // If results is empty due to early failure, create a basic error result
        if (results.length === 0) {
          results = [{
            url,
            status: 'partial-success',
            errorCount: 1,
            logs: [{
              type: 'crawl-initialization-error',
              message: `Failed to initialize crawl: ${crawlError.message}`,
              timestamp: new Date().toISOString(),
              pageUrl: url,
              stack: crawlError.stack
            }],
            depth: 0,
            navigationSuccessful: false
          }];
        }
      }

      // Generate enhanced markdown report with all collected data
      const markdownOutput = generateMarkdownReport(url, results);

      return {
        status: 200,
        headers: { 
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "no-cache"
        },
        body: markdownOutput
      };

    } catch (error) {
      context.error('Critical system error:', error.message);
      context.error('Stack trace:', error.stack);

      let errorMessage = error.message;
      let suggestions = '';

      // Provide specific error handling suggestions
      if (error.message.includes('timeout') || error.message.includes('Navigation timeout')) {
        suggestions = `\n\n## Possible Solutions\n- The website may be slow or unresponsive\n- Try reducing the number of pages to crawl\n- Check if the website is accessible from your browser\n`;
      } else if (error.message.includes('net::ERR_')) {
        suggestions = `\n\n## Possible Solutions\n- Check your internet connection\n- Verify the URL is correct and accessible\n- The website may be blocking automated requests\n`;
      } else if (error.message.includes('Browser') || error.message.includes('Chrome')) {
        suggestions = `\n\n## Possible Solutions\n- Browser initialization failed\n- Chrome may not be properly installed in the container\n- Check Docker configuration and Chrome dependencies\n`;
      }

      // Generate report even for critical failures if we have partial results
      let reportContent = '';
      if (results && results.length > 0) {
        try {
          reportContent = generateMarkdownReport(url, results);
          reportContent += `\n\n---\n## Critical Error During Crawl\n\n**Error:** ${errorMessage}\n**Timestamp:** ${new Date().toISOString()}\n\n**Note:** The above results were collected before the critical error occurred.${suggestions}`;
        } catch (reportError) {
          context.error('Failed to generate report from partial results:', reportError.message);
          reportContent = `# Crawl Partially Completed\n\n**Error:** ${errorMessage}\n\n**URL:** ${url}\n**Timestamp:** ${new Date().toISOString()}\n\n**Partial Results:** ${results.length} pages were processed before the critical error occurred.\n\nReport generation failed, but crawl data was collected.${suggestions}`;
        }
      } else {
        reportContent = `# Crawl Failed\n\n**Error:** ${errorMessage}\n\n**URL:** ${url}\n**Timestamp:** ${new Date().toISOString()}\n\n**Results:** No pages could be processed due to the critical error.${suggestions}\n\n---\n*If this error persists, please check the website accessibility and try again with different parameters.*`;
      }

      return {
        status: results && results.length > 0 ? 200 : 500,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        body: reportContent
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
  }
});