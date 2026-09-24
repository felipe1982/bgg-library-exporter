// app.js
const PROXY_LIST = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`
];

const BGG_API_BASE = 'https://boardgamegeek.com/xmlapi2';
const GEEKDO_API_BASE = 'https://api.geekdo.com/api';

const CACHE_TTL_WISHLIST_MS = 12 * 60 * 60 * 1000; // 12 hours
const CACHE_TTL_GAME_MS = 2 * 60 * 60 * 1000;      // 2 hours
const THROTTLE_DELAY_MS = 5000;                    // 5-second polite pacing

document.getElementById('search-btn').addEventListener('click', initiateSearch);

async function initiateSearch() {
    const username = document.getElementById('username').value.trim();
    const country = document.getElementById('country').value.trim().toLowerCase();
    const bypassCache = document.getElementById('bypass-cache').checked;
    
    if (!username || !country) {
        alert('Please enter both a username and a country.');
        return;
    }

    toggleLoading(true, 'Fetching wishlist...');
    clearResults();

    try {
        const wishlist = await getWishlistWithCache(username, bypassCache);
        
        if (!wishlist || wishlist.length === 0) {
            toggleLoading(false);
            alert('No wishlist items found or user does not exist.');
            return;
        }

        const allResults = [];
        const total = wishlist.length;

        for (let i = 0; i < total; i++) {
            const game = wishlist[i];
            updateLoadingText(`Checking market and trades (${i + 1}/${total}): ${game.name}`);

            try {
                const gameData = await getGameMarketWithCache(game.id, bypassCache);

                // Filter by country
                gameData.trades.forEach(trade => {
                    if (trade.country && trade.country.toLowerCase().includes(country)) {
                        allResults.push({
                            gameName: game.name,
                            thumbnail: game.thumbnail,
                            username: trade.username,
                            type: 'Trade',
                            price: null,
                            link: `https://boardgamegeek.com/user/${trade.username}`
                        });
                    }
                });

                gameData.sales.forEach(sale => {
                    if (sale.country && sale.country.toLowerCase().includes(country)) {
                        allResults.push({
                            gameName: game.name,
                            thumbnail: game.thumbnail,
                            username: sale.username,
                            type: 'Sale',
                            price: sale.price,
                            link: `https://boardgamegeek.com/market/product/${sale.marketId}`
                        });
                    }
                });
            } catch (err) {
                console.warn(`Skipping game ${game.name} due to fetch error:`, err);
            }

            // Apply throttling delay only if more items remain and item was not from cache
            if (i < total - 1) {
                await countdownPause(THROTTLE_DELAY_MS);
            }
        }

        displayResults(allResults);

    } catch (error) {
        console.error('Fatal search error:', error);
        alert(`Search could not be completed: ${error.message}`);
    } finally {
        toggleLoading(false);
    }
}

// Fetch with automatic proxy failover and exponential backoff
async function fetchWithBackoff(targetUrl, maxRetries = 4, baseDelay = 3000) {
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Alternate proxies across attempts if retrying
        const proxySelector = PROXY_LIST[attempt % PROXY_LIST.length];
        const requestUrl = proxySelector(targetUrl);

        try {
            const response = await fetch(requestUrl);

            // BGG 202 (queued) or rate limit responses (429/503)
            if (response.status === 202 || response.status === 429 || response.status === 503) {
                const delay = baseDelay * Math.pow(2, attempt);
                updateSubStatus(`BGG is preparing data (Status ${response.status}). Retrying in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            if (!response.ok) {
                throw new Error(`HTTP error ${response.status}`);
            }

            const text = await response.text();
            
            // Check for BGG error responses inside 200 bodies
            if (text.includes('<message>Your request for this collection has been accepted and will be processed')) {
                const delay = baseDelay * Math.pow(2, attempt);
                updateSubStatus(`Collection request queued by BGG. Retrying in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            updateSubStatus('');
            return text;

        } catch (err) {
            lastError = err;
            const delay = baseDelay * Math.pow(2, attempt);
            updateSubStatus(`Connection issue. Retrying with alternate route in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    updateSubStatus('');
    throw lastError || new Error('Request failed after maximum backoff retries.');
}

// Wishlist handling with localStorage caching
async function getWishlistWithCache(username, bypassCache) {
    const cacheKey = `bgg_wishlist_${username.toLowerCase()}`;

    if (!bypassCache) {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Date.now() - parsed.timestamp < CACHE_TTL_WISHLIST_MS) {
                    updateSubStatus('Loaded wishlist from local cache.');
                    return parsed.data;
                }
            } catch (e) {
                localStorage.removeItem(cacheKey);
            }
        }
    }

    const url = `${BGG_API_BASE}/collection?username=${encodeURIComponent(username)}&wishlist=1`;
    const xmlText = await fetchWithBackoff(url);
    const json = xmlToJson(xmlText);
    
    const items = json.items?.item || [];
    const wishlistArray = Array.isArray(items) ? items : [items];
    
    const cleanList = wishlistArray
        .filter(item => item && item['@_objectid'])
        .map(item => ({
            id: item['@_objectid'],
            name: item.name && item.name['#text'] ? item.name['#text'] : (item.name || 'Unknown Title'),
            thumbnail: item.thumbnail || ''
        }));

    localStorage.setItem(cacheKey, JSON.stringify({
        timestamp: Date.now(),
        data: cleanList
    }));

    return cleanList;
}

// Market and trade data handling with localStorage caching
async function getGameMarketWithCache(gameId, bypassCache) {
    const cacheKey = `bgg_market_${gameId}`;

    if (!bypassCache) {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Date.now() - parsed.timestamp < CACHE_TTL_GAME_MS) {
                    return parsed.data;
                }
            } catch (e) {
                localStorage.removeItem(cacheKey);
            }
        }
    }

    const tradeUrl = `${GEEKDO_API_BASE}/collections?objectid=${gameId}&objecttype=thing&fortrade=1`;
    const saleUrl = `${GEEKDO_API_BASE}/market/products?objectid=${gameId}&objecttype=thing&stock=instock`;

    const trades = [];
    const sales = [];

    try {
        const tradeText = await fetchWithBackoff(tradeUrl, 2, 2000);
        if (tradeText.startsWith('{')) {
            const parsedTrade = JSON.parse(tradeText);
            (parsedTrade.items || []).forEach(item => {
                if (item.user) {
                    trades.push({
                        username: item.user.username,
                        country: item.user.country || ''
                    });
                }
            });
        }
    } catch (e) {
        console.warn(`Could not load trades for game ${gameId}`);
    }

    try {
        const saleText = await fetchWithBackoff(saleUrl, 2, 2000);
        if (saleText.startsWith('{')) {
            const parsedSale = JSON.parse(saleText);
            (parsedSale.items || []).forEach(item => {
                if (item.user) {
                    sales.push({
                        username: item.user.username,
                        country: item.user.country || '',
                        price: item.price ? `${item.price.currency} ${item.price.value}` : 'Listed',
                        marketId: item.id
                    });
                }
            });
        }
    } catch (e) {
        console.warn(`Could not load sales for game ${gameId}`);
    }

    const result = { trades, sales };

    localStorage.setItem(cacheKey, JSON.stringify({
        timestamp: Date.now(),
        data: result
    }));

    return result;
}

function countdownPause(durationMs) {
    return new Promise(resolve => {
        let remaining = durationMs / 1000;
        updateSubStatus(`Polite rate pacing: waiting ${remaining}s before next request...`);
        
        const interval = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(interval);
                updateSubStatus('');
                resolve();
            } else {
                updateSubStatus(`Polite rate pacing: waiting ${remaining}s before next request...`);
            }
        }, 1000);
    });
}

function xmlToJson(xmlString) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlString, 'text/xml');
    
    function parseNode(node) {
        const obj = {};
        if (node.nodeType === 1 && node.attributes.length > 0) {
            for (let j = 0; j < node.attributes.length; j++) {
                const attribute = node.attributes.item(j);
                obj[`@_${attribute.nodeName}`] = attribute.nodeValue;
            }
        } else if (node.nodeType === 3) {
            return node.nodeValue.trim();
        }

        if (node.hasChildNodes()) {
            for (let i = 0; i < node.childNodes.length; i++) {
                const item = node.childNodes.item(i);
                const nodeName = item.nodeName;
                if (nodeName === '#text') {
                    const text = item.nodeValue.trim();
                    if (text) obj['#text'] = text;
                } else {
                    const childObj = parseNode(item);
                    if (obj[nodeName] === undefined) {
                        obj[nodeName] = childObj;
                    } else {
                        if (!Array.isArray(obj[nodeName])) {
                            obj[nodeName] = [obj[nodeName]];
                        }
                        obj[nodeName].push(childObj);
                    }
                }
            }
        }

        if (Object.keys(obj).length === 1 && obj['#text']) {
            return obj['#text'];
        }
        return obj;
    }
    return parseNode(xml.documentElement);
}

function displayResults(results) {
    const grid = document.getElementById('results-grid');
    grid.innerHTML = '';

    if (results.length === 0) {
        grid.innerHTML = '<p>No local matches found for your wishlist.</p>';
        return;
    }

    results.forEach(res => {
        const card = document.createElement('div');
        card.className = 'card';

        const priceHtml = res.type === 'Sale' ? `<p class="card-detail"><strong>Price:</strong> ${res.price}</p>` : '';
        const badgeClass = res.type === 'Sale' ? 'sale' : 'trade';

        card.innerHTML = `
            <div class="card-img" style="background-image: url('${res.thumbnail}')"></div>
            <div class="card-content">
                <span class="badge ${badgeClass}">${res.type}</span>
                <h3 class="card-title">${res.gameName}</h3>
                <p class="card-detail"><strong>User:</strong> ${res.username}</p>
                ${priceHtml}
                <a href="${res.link}" target="_blank" rel="noopener noreferrer" class="card-link">View ${res.type === 'Sale' ? 'Listing' : 'Profile'}</a>
            </div>
        `;
        grid.appendChild(card);
    });
}

function toggleLoading(show, text = '') {
    const indicator = document.getElementById('loading-indicator');
    const textEl = document.getElementById('loading-text');
    const subStatusEl = document.getElementById('sub-status');
    if (show) {
        indicator.classList.remove('hidden');
        textEl.textContent = text;
        subStatusEl.textContent = '';
    } else {
        indicator.classList.add('hidden');
    }
}

function updateLoadingText(text) {
    document.getElementById('loading-text').textContent = text;
}

function updateSubStatus(text) {
    document.getElementById('sub-status').textContent = text;
}

function clearResults() {
    document.getElementById('results-grid').innerHTML = '';
}
